import {
  defineScope,
  isAbortError,
  type MutationEvent,
  type OlasPlugin,
  type QueryHost,
  type Scope,
} from '@kontsedal/olas-core'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { PROTOCOL_VERSION, type QueueEntry } from './protocol'

/** The plugin's name — and the `origin` its replays carry. */
export const MUTATION_QUEUE_PLUGIN_NAME = 'olas-mutation-queue'

/** How far in the future a stored `enqueuedAt` may sit, for clock drift between tabs and loads. */
const CLOCK_SKEW_MS = 5 * 60_000

/** The service `mutationQueuePlugin` provides, under the `MutationQueue` scope. */
export type MutationQueueService = {
  /**
   * Replay every pending entry now, instead of waiting for the next reload
   * or reconnect. Resolves when the pass finishes. A no-op while another pass
   * (in this tab, or holding the cross-tab replay lock) is running.
   */
  replayNow(): Promise<void>
}

/**
 * The scope the queue's service lives under: `ctx.inject(MutationQueue)` in
 * a controller, `root.inject(MutationQueue)` outside one.
 */
export const MutationQueue: Scope<MutationQueueService> = defineScope<MutationQueueService>({
  name: 'olas-mutation-queue',
})

/**
 * Options for `mutationQueuePlugin(...)`. SPEC §13.3.
 *
 * - `storage` — the underlying durable store. `localStorageAdapter()` from
 *   `@kontsedal/olas-persist` is the typical default; `indexedDbAdapter()`
 *   when payloads are large or async write is preferred.
 * - `keyPrefix` — namespace prefix in storage. Required to keep multiple
 *   apps on the same origin from colliding. Recommended shape:
 *   `'<my-app>/mutations/v1'`.
 * - `maxAttempts` — bound on replay attempts per entry. After exhaustion
 *   the entry is dropped from storage and `onReplayError` fires with the
 *   final error. Defaults to `5`.
 * - `onReplayError` — called when the queue gives up on an entry: a failure
 *   after `maxAttempts`, a failure `isRetryable` rejects, a TTL expiry, or an
 *   entry whose mutation `id` no imported module registered. The handler is
 *   the integration point for telemetry / user-facing error toasts on lost
 *   mutations.
 * - `onWarn` — soft conditions: malformed entry in storage, serialization
 *   failure (variables JSON cannot encode, such as a `BigInt` or a cycle).
 *   Default: `console.warn`.
 */
export type MutationQueueOptions = {
  storage: StorageAdapter
  keyPrefix: string
  maxAttempts?: number
  /**
   * Whether a failed run is worth another attempt on a later load or
   * reconnect. Return `false` for a failure that will never succeed, such as
   * a 400, 409 or 422: the queue drops the entry at once and reports it
   * through `onReplayError`, instead of spending every `maxAttempts` on it.
   * It is asked for a live run's failure and for a replay's. `mutate` is the
   * app's own function, so the queue cannot read a status code itself: throw
   * an error that carries one, and read it here. A throw from this function
   * is reported through `onWarn`, and the entry is kept. Defaults to
   * `() => true`: every failure is retried until `maxAttempts`.
   */
  isRetryable?: (err: unknown, entry: QueueEntry) => boolean
  onReplayError?: (err: unknown, entry: QueueEntry) => void
  /**
   * Fires on every non-final replay attempt failure (i.e. when the entry
   * will be re-tried on the next page load because `attempts <
   * maxAttempts`). Without this, transient failures are completely silent
   * and UIs can't show a "we'll retry later" indicator. Distinguished from
   * `onReplayError` which is the terminal-after-exhaustion variant.
   */
  onReplayAttempt?: (err: unknown, entry: QueueEntry) => void
  /**
   * Compute an idempotency key from `variables`. When two enqueues with
   * the same `mutationId` produce the same key, the second is collapsed
   * onto the first: the in-process run continues (the consumer's mutation
   * promise resolves with the second call's result), but no new durable
   * entry is written. Client-side dedupe only; server-side dedupe by the
   * same key is the authoritative gate. Defaults to `undefined` (no
   * dedupe).
   */
  dedupeBy?: (mutationId: string, variables: unknown) => string | undefined
  /**
   * Migrate a raw queue entry of a prior `PROTOCOL_VERSION`. Receives the
   * parsed JSON and the version number it carried. Returns a
   * forward-compatible `QueueEntry`, or `null` to drop the entry. Without
   * this, a `v` bump silently discards every queued mutation (the current
   * default — fine while the protocol is v1).
   */
  migrate?: (raw: unknown, fromVersion: number) => QueueEntry | null
  /**
   * Max age (in ms) a persisted entry is kept on disk. On `init` the
   * plugin drops entries older than `Date.now() - ttlMs` before any
   * replay attempt. Useful for "if this mutation has been stuck for a
   * week, give up." The drop fires `onReplayError` with a sentinel
   * Error so consumers can surface to telemetry. Defaults to
   * `Infinity` (no TTL — current behavior).
   */
  ttlMs?: number
  /**
   * Base backoff in ms between replay attempts for the *same* runId
   * across page loads. Effective delay is `backoffMs * 2^(attempts-1)`,
   * capped at `maxBackoffMs`. Without this, an unhealthy endpoint
   * gets hit `maxAttempts` times in quick succession every load.
   * Defaults to `0` (no backoff — current behavior).
   */
  backoffMs?: number
  /**
   * Cap on the exponential backoff. Defaults to `60_000` (60s).
   */
  maxBackoffMs?: number
  /**
   * Soft byte-size budget per durable entry. When the JSON-serialized
   * envelope exceeds this, `onWarn(...)` fires with the byte count and the
   * write proceeds anyway. Useful for catching unbounded variable growth
   * before `localStorage` quota errors start surfacing. Defaults to
   * `64 * 1024` (64 KB). Set to `Infinity` to disable.
   */
  maxEntryBytes?: number
  /**
   * Called after a queued mutation **replays successfully** on startup /
   * reconnect, with the entry, the mutate's return value, and the root's
   * `QueryHost` for cache reconciliation. A replay writes server truth
   * outside any live query's knowledge — without invalidating the affected
   * entries here, subscribers keep showing stale data until their own
   * `staleTime` lapses:
   *
   * ```ts
   * onReplaySettle: (entry, result, queries) => {
   *   void queries.invalidate('orders/list', [])   // `key(...)` output, not call args
   * }
   * ```
   *
   * Errors thrown by the handler are swallowed (routed to `onWarn`) so a
   * buggy reconciler can't break replay.
   */
  onReplaySettle?: (entry: QueueEntry, result: unknown, queries: QueryHost) => void
  onWarn?: (message: string, cause?: unknown) => void
}

/**
 * Plugin that persists every run of a `defineMutation({ meta: { persist: true } })`
 * mutation to a `StorageAdapter` and replays pending entries at startup.
 *
 * Lifecycle per run (the plugin's `onMutation` hook):
 *  1. `'start'` → write a `QueueEntry` to storage.
 *  2. `'success'` → delete the entry. The server accepted; no replay needed.
 *  3. `'error'` → delete the entry IF `attempts >= maxAttempts` or
 *     `isRetryable` says the failure is final, else leave it and let the next
 *     page load trigger another attempt. (Within a single page load,
 *     in-process retries are the definition's `retry` policy.)
 *  4. `'cancel'` → leave the entry in place. A page reload mid-run looks
 *     indistinguishable from an explicit cancel at the plugin layer; the next
 *     startup replays.
 *
 * Two rules keep one logical operation to one durable entry:
 *  - A run that SUCCEEDS also drops the entries left by earlier runs of the
 *    same logical operation that settled in error — that run is the manual
 *    retry, and replaying what it superseded would write twice. Identity
 *    comes from `dedupeBy`, or from the variables when it isn't configured.
 *  - A replay pass SKIPS entries whose run is executing in this tab right
 *    now, so an `online` event inside the enqueue→settle window can't fire
 *    a live request a second time.
 *
 * At startup (plugin setup):
 *  - List all keys under `keyPrefix`, parse each as a `QueueEntry`.
 *  - Group by `mutationId`; within each group sort by `seq`.
 *  - For each entry, check a definition is registered. If absent (module
 *    not imported yet), call `onReplayError(err, entry)` and leave it in
 *    storage. If present, run it through `host.mutations.run` — the engine's
 *    runner, so the definition's `retry` applies and `mutate` gets the root's
 *    `deps` — serially per mutation id.
 *
 * **Idempotency** is the consumer's responsibility — include an
 * `idempotencyKey` in your variables and have the server dedupe by it.
 * The queue makes no attempt at exactly-once delivery; it gives at-least-
 * once-until-success.
 *
 * **Variables MUST be JSON-serializable.** The entry is stored as JSON. A
 * `BigInt` or a cycle throws at enqueue; the throw is reported via `onWarn`,
 * and the in-process run continues without a durable entry. JSON drops a
 * function or a symbol silently, and a class instance loses its prototype,
 * so a replay sees plain data.
 */
export function mutationQueuePlugin(options: MutationQueueOptions): OlasPlugin {
  const { storage: adapter, keyPrefix } = options
  const maxAttempts = options.maxAttempts ?? 5
  const isRetryable = options.isRetryable
  const onReplayError = options.onReplayError ?? defaultReplayError
  const onReplayAttempt = options.onReplayAttempt
  const onReplaySettle = options.onReplaySettle
  const dedupeBy = options.dedupeBy
  const migrate = options.migrate
  const ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY
  const backoffMs = options.backoffMs ?? 0
  const maxBackoffMs = options.maxBackoffMs ?? 60_000
  const maxEntryBytes = options.maxEntryBytes ?? 64 * 1024
  const onWarn = options.onWarn ?? defaultWarn

  if (typeof keyPrefix !== 'string' || keyPrefix.length === 0) {
    throw new Error('[olas/mutation-queue] keyPrefix is required.')
  }

  return {
    name: MUTATION_QUEUE_PLUGIN_NAME,
    setup(host) {
      const mutations = host.mutations
      const queries = host.queries
      if (mutations === null || queries === null) {
        throw new Error(
          '[olas/mutation-queue] mutationQueuePlugin needs a query engine: ' +
            'createRoot(app, { queries: queryEngine(), plugins: [mutationQueuePlugin({ … })] })',
        )
      }

      /**
       * Monotonic per-tab sequence counter. Persisted entries take this as their
       * `seq` so replay ordering survives wall-clock drift. **Seeded from
       * `Date.now()` at construction** so a post-restart enqueue always sorts
       * after every pre-restart entry WITHOUT waiting to read the disk — the old
       * design primed this from disk inside `replayAll` (async), so an enqueue
       * that raced init got `seq` 1 and jumped ahead of prior-session entries
       * (T6.2). The `replayAll` priming below raises the counter past every
       * `seq` on disk; it can only raise it, never lower it. Two tabs that
       * start in the same millisecond still mint equal values, and
       * `compareEntries` breaks those ties by `runId`.
       */
      let seqCounter = Date.now()

      /**
       * Map of active `idempotencyKey` → `runId`. When `dedupeBy` returns a
       * key that matches an in-flight entry, the second enqueue collapses
       * onto the first (no new write). Cleared on settle (success/error after
       * exhaustion, NOT cancelled).
       */
      const activeKeys = new Map<string, string>()

      /**
       * Collapsed `runId` → the `runId` of the durable entry it collapsed onto.
       * A `dedupeBy` collapse writes no entry of its own, so its settle has to
       * act on the OWNER's entry — deleting `event.runId` would target a key
       * that was never written and leave the owner on disk to replay after the
       * collapsed run already succeeded.
       */
      const runAlias = new Map<string, string>()

      /**
       * Durable entries left on disk by a run that settled in error below
       * `maxAttempts` — `runId` → the logical operation it belongs to. A later
       * run of the SAME logical operation that succeeds drops them: that run
       * is the manual retry, and the server has now accepted the write.
       * Without this the stale entry replays on the next load and writes twice.
       */
      const retainedFailures = new Map<string, { mutationId: string; identity: string }>()

      /**
       * Identity of every run between its enqueue and its settle.
       * `MutationSettleEvent` carries no variables, so the identity has to be
       * computed at enqueue time and parked here.
       */
      const runIdentity = new Map<string, string | undefined>()

      /**
       * Runs executing in THIS tab right now — `runId` → the `runId` of the
       * durable entry backing it (its own, or the owner it collapsed onto).
       * A replay pass skips these: an `online` event or a `replayNow()` inside
       * the enqueue→settle window would otherwise fire the same request twice.
       * Cross-tab overlap is a separate problem, handled by `withReplayLock`.
       */
      const inFlightRuns = new Map<string, string>()

      const isEntryInFlight = (runId: string): boolean => {
        for (const owner of inFlightRuns.values()) {
          if (owner === runId) return true
        }
        return false
      }

      /**
       * Stable name for "the same logical operation", used to recognise a manual
       * retry of a run that already failed. `dedupeBy` is authoritative when the
       * consumer supplies it; otherwise the variables themselves stand in, since
       * a retry re-submits them unchanged while a genuinely new operation of the
       * same `mutationId` carries different ones. Unserializable variables have
       * no identity — those runs were never durable either (`writeEntry` warns).
       */
      const identityOf = (
        mutationId: string,
        variables: unknown,
        dedupeKey: string | undefined,
      ): string | undefined => {
        if (dedupeKey !== undefined) return `${mutationId}:key:${dedupeKey}`
        try {
          return `${mutationId}:vars:${JSON.stringify(variables ?? null)}`
        } catch {
          return undefined
        }
      }

      // Per-runId attempt counter so a replay that itself enqueues bumps the
      // attempts counter rather than allocating a fresh slot.
      const knownRuns = new Map<string, QueueEntry>()
      // Replays run in the background after setup and call `onReplayError` for
      // any that settle in failure; setup does not wait for them.
      let disposed = false
      // Guards concurrent replay runs (startup / reconnect / `replayNow` all
      // funnel through `runReplay`) so a set of entries isn't replayed twice at once.
      let replaying = false
      // Outstanding backoff sleepers, by their wake function — `dispose()`
      // calls each, which resolves the wait so the per-mutationId driver
      // bails out at once.
      const backoffSleepers = new Set<() => void>()
      // Outstanding `waitForOnline` waiters — `dispose()` triggers each so a
      // pass that parked while offline releases the cross-tab replay lock and
      // drops its `online` listener instead of waiting for a network that may
      // never come back.
      const onlineWaiters = new Set<() => void>()

      // Tracks in-flight writes per runId so a fast `delete` can't race ahead
      // of its preceding `write` (the persist-after-delete bug). Callers that
      // await sequentially (e.g. `replayEntry`) pay zero overhead — the write
      // has cleared its slot by the time the delete starts. Callers that fire
      // both fire-and-forget (the `'start'` → settle `onMutation` pair
      // path on a synchronous mutation) get ordered correctly because the
      // entry is registered before `writeEntry`'s first `await`.
      const pendingWrites = new Map<string, Promise<unknown>>()

      const entryKey = (mutationId: string, runId: string): string =>
        `${keyPrefix}/${mutationId}/${runId}`

      /**
       * Whether a failure leaves the entry for another attempt. A throwing
       * `isRetryable` keeps it, the behavior without the option.
       */
      const retryable = (err: unknown, entry: QueueEntry): boolean => {
        if (isRetryable === undefined) return true
        try {
          return isRetryable(err, entry)
        } catch (cause) {
          onWarn('[olas/mutation-queue] isRetryable threw; keeping the entry for a retry', cause)
          return true
        }
      }

      /** Drop the dedupe key mapped to `runId` (we don't index runId→key). */
      const clearActiveKey = (runId: string): void => {
        for (const [k, v] of activeKeys) {
          if (v === runId) {
            activeKeys.delete(k)
            break
          }
        }
      }

      const writeEntry = async (entry: QueueEntry): Promise<void> => {
        try {
          const json = JSON.stringify(entry)
          if (maxEntryBytes !== Number.POSITIVE_INFINITY && json.length > maxEntryBytes) {
            onWarn(
              `[olas/mutation-queue] entry for ${entry.mutationId}/${entry.runId} is ${json.length} bytes,` +
                ` over the ${maxEntryBytes}-byte soft cap. Large variables risk hitting storage quotas` +
                ' (localStorage is typically 5–10 MB total per origin); consider trimming the payload or' +
                ' moving the queue to indexedDbAdapter.',
            )
          }
          const writeP = Promise.resolve(adapter.set(entryKey(entry.mutationId, entry.runId), json))
          pendingWrites.set(entry.runId, writeP)
          try {
            await writeP
            knownRuns.set(entry.runId, entry)
          } finally {
            if (pendingWrites.get(entry.runId) === writeP) {
              pendingWrites.delete(entry.runId)
            }
          }
        } catch (cause) {
          onWarn(
            `[olas/mutation-queue] failed to persist enqueue for ${entry.mutationId}/${entry.runId}: ` +
              'the variables are not JSON-serializable, or the storage rejected the write. The in-process' +
              ' run continues, but the entry is not durable.',
            cause,
          )
        }
      }

      const deleteEntry = async (mutationId: string, runId: string): Promise<void> => {
        const pending = pendingWrites.get(runId)
        if (pending !== undefined) {
          // Concurrent write+delete on the same runId — wait for the write to
          // land first so we don't leave a phantom entry behind.
          try {
            await pending
          } catch {
            /* writeEntry handles its own errors via onWarn */
          }
        }
        knownRuns.delete(runId)
        try {
          await adapter.delete(entryKey(mutationId, runId))
        } catch (cause) {
          onWarn(`[olas/mutation-queue] failed to drop entry ${mutationId}/${runId}`, cause)
        }
      }

      /**
       * Drop the entries that earlier failed runs of this logical operation left
       * behind, now that `keepRunId` has succeeded. Only runs that already
       * SETTLED in error are eligible — a run still executing in this tab keeps
       * its own entry, so a second concurrent submit of identical variables stays
       * durable.
       */
      const dropSupersededFailures = (
        mutationId: string,
        identity: string | undefined,
        keepRunId: string,
      ): void => {
        if (identity === undefined) return
        for (const [runId, info] of [...retainedFailures]) {
          if (runId === keepRunId) continue
          if (info.mutationId !== mutationId || info.identity !== identity) continue
          if (isEntryInFlight(runId)) continue
          retainedFailures.delete(runId)
          clearActiveKey(runId)
          void deleteEntry(mutationId, runId)
        }
      }

      /**
       * Storage is same-origin state that a user, an extension or an old build
       * can write, so an entry is checked in full before anything trusts it:
       * the shape, an attempt count that is a whole number, and timestamps
       * that are not in the future. A future `enqueuedAt` would never expire
       * under `ttlMs`. A migrated entry is checked the same way.
       */
      const isValidEntry = (value: unknown): value is QueueEntry => {
        if (value === null || typeof value !== 'object') return false
        const e = value as Record<string, unknown>
        return (
          e.v === PROTOCOL_VERSION &&
          typeof e.mutationId === 'string' &&
          e.mutationId.length > 0 &&
          typeof e.runId === 'string' &&
          e.runId.length > 0 &&
          Number.isInteger(e.attempts) &&
          (e.attempts as number) >= 0 &&
          typeof e.enqueuedAt === 'number' &&
          Number.isFinite(e.enqueuedAt) &&
          e.enqueuedAt <= Date.now() + CLOCK_SKEW_MS &&
          (e.seq === undefined || (typeof e.seq === 'number' && Number.isFinite(e.seq))) &&
          (e.idempotencyKey === undefined || typeof e.idempotencyKey === 'string')
        )
      }

      /** Parse one stored value. `migrated` says whether `migrate` produced it. */
      const parseEntry = (raw: unknown): { entry: QueueEntry; migrated: boolean } | null => {
        if (typeof raw !== 'string') return null
        try {
          const parsed = JSON.parse(raw) as unknown
          if (parsed === null || typeof parsed !== 'object') return null
          const version = (parsed as Record<string, unknown>).v
          if (version === PROTOCOL_VERSION) {
            return isValidEntry(parsed) ? { entry: parsed, migrated: false } : null
          }
          // Try the migrator; if it returns null (or none is configured), drop.
          if (migrate === undefined || typeof version !== 'number') return null
          let migrated: unknown
          try {
            migrated = migrate(parsed, version)
          } catch (err) {
            onWarn('[olas/mutation-queue] migrate threw; dropping entry', err)
            return null
          }
          return isValidEntry(migrated) ? { entry: migrated, migrated: true } : null
        } catch {
          return null
        }
      }

      /**
       * List every persisted entry under `keyPrefix`. The `StorageAdapter`
       * contract doesn't include `keys()`, so we attempt a structural cast to
       * an `Iterable`-shaped adapter; falls back to an empty list when the
       * adapter doesn't expose one. Concrete adapters (`localStorageAdapter()`,
       * `indexedDbAdapter`) ship a `keys()` extension for this purpose.
       */
      const listEntries = async (): Promise<QueueEntry[]> => {
        const ext = adapter as StorageAdapter & {
          keys?: () => Iterable<string> | Promise<Iterable<string>>
        }
        if (typeof ext.keys !== 'function') {
          onWarn(
            '[olas/mutation-queue] storage adapter has no keys() method; replay disabled. ' +
              'Use localStorageAdapter() / indexedDbAdapter() from @kontsedal/olas-persist, ' +
              'or implement keys() on your custom adapter.',
          )
          return []
        }
        const keys = await ext.keys()
        const entries: QueueEntry[] = []
        for (const key of keys) {
          if (!key.startsWith(`${keyPrefix}/`)) continue
          try {
            const raw = await adapter.get(key)
            const parsed = parseEntry(raw)
            const expected =
              parsed === null ? undefined : entryKey(parsed.entry.mutationId, parsed.entry.runId)
            if (parsed === null || (key !== expected && !parsed.migrated)) {
              // Malformed, or stored under a key its contents do not name. Every
              // later write and delete goes by the contents' key, so a mismatched
              // one would never be removed and would replay on every load.
              onWarn(`[olas/mutation-queue] dropping malformed entry at ${key}`)
              try {
                await adapter.delete(key)
              } catch {
                /* best-effort cleanup; the warn above is the primary signal */
              }
              continue
            }
            if (parsed.migrated) {
              // Store the migrated entry under the key its new contents name,
              // and drop the old one, so the migration runs once. A migration
              // that renames the mutation otherwise leaves the old key behind.
              try {
                await adapter.set(expected as string, JSON.stringify(parsed.entry))
                if (key !== expected) await adapter.delete(key)
              } catch (cause) {
                onWarn(`[olas/mutation-queue] failed to rewrite migrated entry at ${key}`, cause)
              }
            }
            entries.push(parsed.entry)
          } catch (cause) {
            onWarn(`[olas/mutation-queue] failed to read ${key}`, cause)
          }
        }
        return entries
      }

      /**
       * Replay one entry against its registered handler. Returns once the
       * mutate has settled (success or final error) — the per-mutationId
       * serial-queue driver awaits this.
       */
      const replayEntry = async (entry: QueueEntry): Promise<void> => {
        if (disposed) return
        const { mutationId, runId } = entry
        if (isEntryInFlight(runId)) {
          // The run backing this entry is executing in this tab right now. Its
          // own settle will drop the entry; replaying it here would issue the
          // same request a second time. Reached when an `online` event or a
          // `replayNow()` lands inside the enqueue→settle window.
          if (__DEV__) {
            host.debug({
              kind: 'replay:skipped',
              mutationId,
              runId,
              reason: 'in-flight',
            } satisfies LaneEvent)
          }
          return
        }
        const definition = mutations.get(mutationId)
        if (definition === undefined) {
          // Module hasn't been imported — leave entry in place and surface so
          // the user knows it's stuck. They can either import the module to
          // unstick it or delete the entry from storage.
          if (__DEV__) {
            host.debug({
              kind: 'replay:skipped',
              mutationId,
              runId,
              reason: 'not-registered',
            } satisfies LaneEvent)
          }
          onReplayError(
            new Error(
              `[olas/mutation-queue] no registered mutation for "${entry.mutationId}"; ` +
                'replay skipped. Ensure the module that calls defineMutation(...) is imported.',
            ),
            entry,
          )
          return
        }
        if (definition.meta.persist !== true) {
          // Stored data named a mutation that never opted in to the queue. The
          // queue writes entries only for `meta.persist` runs, so this one came
          // from somewhere else: drop it rather than let storage pick what runs.
          if (__DEV__) {
            host.debug({
              kind: 'replay:skipped',
              mutationId,
              runId,
              reason: 'not-persisted',
            } satisfies LaneEvent)
          }
          await deleteEntry(mutationId, runId)
          onReplayError(
            new Error(
              `[olas/mutation-queue] "${entry.mutationId}" is not a persisted mutation (meta.persist is not true); ` +
                'dropped its stored entry without running it.',
            ),
            entry,
          )
          return
        }
        if (entry.attempts >= maxAttempts) {
          // Already exhausted on a previous load; drop and surface.
          if (__DEV__) {
            host.debug({
              kind: 'replay:skipped',
              mutationId,
              runId,
              reason: 'max-attempts',
            } satisfies LaneEvent)
          }
          await deleteEntry(mutationId, runId)
          onReplayError(
            new Error(
              `[olas/mutation-queue] giving up on "${mutationId}/${runId}" after ${entry.attempts} attempts.`,
            ),
            entry,
          )
          return
        }
        // Bump the attempts counter durably BEFORE running so a hard crash
        // during the mutate doesn't loop forever on the same entry.
        const next: QueueEntry = { ...entry, attempts: entry.attempts + 1 }
        const attempt = next.attempts
        await writeEntry(next)
        if (__DEV__) {
          host.debug({ kind: 'replay:attempt', mutationId, runId, attempt } satisfies LaneEvent)
        }
        try {
          // Through the engine's runner: the definition's `retry` applies, `mutate`
          // gets the root's `deps`, the run counts toward `waitForIdle()`, and its
          // `onMutation` events carry this plugin's name — so `onMutation` below
          // does not persist its own replay a second time.
          const result = await mutations.run(mutationId, entry.variables)
          // Success — drop the entry.
          await deleteEntry(mutationId, runId)
          if (__DEV__) {
            host.debug({
              kind: 'replay:result',
              mutationId,
              runId,
              attempt,
              result: 'success',
            } satisfies LaneEvent)
          }
          // Let the app reconcile its cache (a replay wrote server truth outside
          // any live query's knowledge). Swallow handler throws (T6.2).
          if (onReplaySettle !== undefined) {
            try {
              onReplaySettle(entry, result, queries)
            } catch (cause) {
              onWarn('[olas/mutation-queue] onReplaySettle threw', cause)
            }
          }
        } catch (err) {
          // The root disposing mid-run cancels it; that is not a failed attempt.
          // The bumped counter is already on disk, and the next load replays.
          if (disposed || isAbortError(err)) {
            if (__DEV__) {
              host.debug({
                kind: 'replay:result',
                mutationId,
                runId,
                attempt,
                result: 'aborted',
              } satisfies LaneEvent)
            }
            return
          }
          // Single replay attempt failed. If this was the last allowed
          // attempt, or the failure is one no retry can fix, drop and
          // surface; otherwise leave the entry in place (with the bumped
          // attempts counter) so the next page load tries again, and fire
          // `onReplayAttempt` so consumers can show "retrying" indicators.
          const final = attempt >= maxAttempts
          const retry = !final && retryable(err, next)
          if (__DEV__) {
            host.debug({
              kind: 'replay:result',
              mutationId,
              runId,
              attempt,
              result: retry ? 'retry-later' : final ? 'max-attempts' : 'not-retryable',
              error: err,
            } satisfies LaneEvent)
          }
          if (!retry) {
            await deleteEntry(mutationId, runId)
            onReplayError(err, next)
          } else if (onReplayAttempt !== undefined) {
            try {
              onReplayAttempt(err, next)
            } catch {
              /* don't let a buggy onReplayAttempt break replay */
            }
          }
        }
      }

      /**
       * The backoff wait between replay attempts. `dispose()` wakes every
       * sleeper at once, so a disposing tab releases the cross-tab replay
       * lock now, not after up to `maxBackoffMs`.
       */
      const sleep = (ms: number): Promise<void> => {
        if (disposed) return Promise.resolve()
        return new Promise((resolve) => {
          const wake = (): void => {
            clearTimeout(timer)
            backoffSleepers.delete(wake)
            resolve()
          }
          const timer = setTimeout(wake, ms)
          backoffSleepers.add(wake)
        })
      }

      /**
       * Wait until the tab reports as online. Without this gate, replays burn
       * `maxAttempts` on `fetch` failures the user can't see and the queue
       * silently empties. Where there is no `navigator` (Node SSR, tests), the
       * host reports online and this resolves at once.
       */
      const waitForOnline = (): Promise<void> => {
        if (disposed || host.network.isOnline()) return Promise.resolve()
        return new Promise((resolve) => {
          // `dispose()` resolves this wait too. The wait sits INSIDE
          // `withReplayLock`, so a tab that disposes while offline would
          // otherwise hold the cross-tab replay lock until the network returned,
          // which may be never.
          let off: () => void = () => {}
          const finish = () => {
            off()
            onlineWaiters.delete(finish)
            resolve()
          }
          onlineWaiters.add(finish)
          off = host.network.onReconnect(finish)
        })
      }

      const lockName = `olas-mq:${keyPrefix}`

      /**
       * Run `fn` under a cross-tab replay lock so two tabs never replay the same
       * entries concurrently (T6.2). Prefers the Web Locks API: with `ifAvailable`
       * a tab that can't get the lock skips this pass — the holding tab replays
       * every entry under the shared prefix (including ours). Falls back to a
       * best-effort, TTL'd `localStorage` lease when Web Locks is unavailable
       * (older Safari); in Node / SSR (neither primitive) there's a single
       * context, so `fn` just runs. The lease is best-effort — Web Locks is the
       * real guarantee.
       */
      const withReplayLock = async (fn: () => Promise<void>): Promise<void> => {
        const locks = getWebLocks()
        if (locks !== undefined) {
          await locks.request(lockName, { ifAvailable: true }, async (lock) => {
            if (lock === null) return // another tab holds it — it replays for us
            await fn()
          })
          return
        }
        const ls = getLeaseStorage()
        if (ls !== undefined) {
          const leaseId = Math.random().toString(36).slice(2, 12)
          if (!acquireLease(ls, lockName, leaseId, onWarn)) return
          const heartbeat = setInterval(() => {
            try {
              ls.setItem(`${lockName}:lease`, `${Date.now()}:${leaseId}`)
            } catch {
              /* lease refresh is best-effort */
            }
          }, LEASE_TTL_MS / 2)
          try {
            await fn()
          } finally {
            clearInterval(heartbeat)
            releaseLease(ls, lockName, leaseId)
          }
          return
        }
        // No coordination primitive available (Node / SSR single context).
        await fn()
      }

      /**
       * Replay all pending entries on init, serialized per mutationId so an
       * `order/create` followed by an `order/cancel` for the same id runs in
       * order. Different mutationIds run in parallel.
       *
       * Blocks until the tab is online before issuing any mutate calls — see
       * `waitForOnline`.
       */
      const replayAll = async (): Promise<void> => {
        const entries = await listEntries()
        if (entries.length === 0) return
        // TTL gate: drop expired entries before waiting for online. A stale
        // entry from a deleted endpoint shouldn't block the online-wait, and
        // shouldn't fan back through the bucket loop just to fail.
        const live: QueueEntry[] = []
        if (ttlMs !== Number.POSITIVE_INFINITY) {
          const now = Date.now()
          for (const e of entries) {
            if (now - e.enqueuedAt > ttlMs) {
              if (__DEV__) {
                host.debug({
                  kind: 'replay:skipped',
                  mutationId: e.mutationId,
                  runId: e.runId,
                  reason: 'ttl-expired',
                } satisfies LaneEvent)
              }
              await deleteEntry(e.mutationId, e.runId)
              onReplayError(
                Object.assign(new Error(`[olas/mutation-queue] dropping ttl-expired entry`), {
                  code: 'ttl-expired' as const,
                }),
                e,
              )
            } else {
              live.push(e)
            }
          }
        } else {
          live.push(...entries)
        }
        if (live.length === 0) return
        await waitForOnline()
        if (disposed) return
        const byMutation = new Map<string, QueueEntry[]>()
        for (const e of live) {
          const bucket = byMutation.get(e.mutationId)
          if (bucket === undefined) byMutation.set(e.mutationId, [e])
          else bucket.push(e)
        }
        // Prime the monotonic counter so post-restart enqueues sit after every
        // pre-restart entry — without this, replay ordering after a reload
        // would mix new and old entries by wall-clock alone.
        for (const e of entries) {
          if (typeof e.seq === 'number' && e.seq > seqCounter) seqCounter = e.seq
        }
        const tasks: Promise<void>[] = []
        for (const bucket of byMutation.values()) {
          bucket.sort(compareEntries)
          tasks.push(
            (async () => {
              for (const entry of bucket) {
                if (disposed) return
                // Exponential backoff against the entry's *prior* attempts.
                // First-ever replay (attempts === 0) runs immediately; the
                // 2nd cross-load attempt waits backoffMs, the 3rd waits 2x,
                // and so on, capped at maxBackoffMs.
                if (backoffMs > 0 && entry.attempts > 0) {
                  const delay = Math.min(backoffMs * 2 ** (entry.attempts - 1), maxBackoffMs)
                  await sleep(delay)
                  if (disposed) return
                }
                await replayEntry(entry)
              }
            })(),
          )
        }
        await Promise.all(tasks)
      }

      /**
       * Single entry point for a replay pass — init, the `online` reconnect
       * listener, and `replayNow()` all funnel through here. The `replaying`
       * guard prevents overlap; `withReplayLock` prevents cross-tab overlap.
       */
      const runReplay = async (): Promise<void> => {
        if (disposed || replaying) return
        replaying = true
        try {
          await withReplayLock(() => replayAll())
        } catch (err) {
          onWarn('[olas/mutation-queue] replay failed', err)
        } finally {
          replaying = false
        }
      }

      // In-session failures retry when the network comes back, not only on reload.
      host.network.onReconnect(() => {
        void runReplay()
      })
      host.provide(MutationQueue, { replayNow: () => runReplay() })

      // The startup replay runs in the background. `root.waitForIdle()` waits for
      // it when the tab starts online; an offline pass parks until reconnect, and
      // tracking it would leave `waitForIdle` hanging for as long as that takes.
      const startup = runReplay()
      if (host.network.isOnline()) host.track(startup)

      /**
       * Entries recorded at `start` and not yet written — `wrapMutate` writes
       * each one before its run's first attempt. A run that never reaches an
       * attempt settles instead, and the settle drops the record.
       */
      const unwritten = new Map<string, QueueEntry>()

      const onStart = (event: MutationEvent, mutationId: string): void => {
        const idempotencyKey = dedupeBy?.(mutationId, event.variables)
        runIdentity.set(event.runId, identityOf(mutationId, event.variables, idempotencyKey))
        if (idempotencyKey !== undefined) {
          const fullKey = `${mutationId}:${idempotencyKey}`
          const existingRunId = activeKeys.get(fullKey)
          if (existingRunId !== undefined && existingRunId !== event.runId) {
            // Already in flight under a different runId — collapse. The
            // in-process run continues (consumer's promise resolves with
            // whatever this attempt produces), but we don't write a second
            // durable entry. The server's dedupe is the canonical gate.
            // The alias makes this run's settle act on the owner's entry.
            runAlias.set(event.runId, existingRunId)
            inFlightRuns.set(event.runId, existingRunId)
            return
          }
          activeKeys.set(fullKey, event.runId)
        }
        inFlightRuns.set(event.runId, event.runId)
        seqCounter += 1
        const entry: QueueEntry = {
          v: PROTOCOL_VERSION,
          mutationId,
          runId: event.runId,
          variables: event.variables,
          attempts: 0,
          enqueuedAt: Date.now(),
          seq: seqCounter,
          idempotencyKey,
        }
        // Written by `wrapMutate`, before the first `mutate` call, so the run is
        // durable before its request goes out. `onMutation` is synchronous and
        // cannot await the write itself.
        unwritten.set(event.runId, entry)
      }

      const onSettle = (event: MutationEvent, mutationId: string): void => {
        // The dedupe key is released ONLY when the durable entry is dropped
        // (success, or error after exhaustion). On a non-terminal error or a
        // cancel the entry stays pending replay, so its key must stay active —
        // else a re-enqueue writes a SECOND durable entry for the same logical
        // mutation. We don't index runId→key, so walk on drop.
        //
        // Every branch acts on `ownerRunId`, the run whose entry is actually on
        // disk. For a `dedupeBy` collapse that is the run this one collapsed
        // onto, not `event.runId`.
        unwritten.delete(event.runId)
        const ownerRunId = runAlias.get(event.runId) ?? event.runId
        const identity = runIdentity.get(event.runId)
        // One settle per run, so the per-run bookkeeping goes here whatever the
        // outcome.
        runAlias.delete(event.runId)
        runIdentity.delete(event.runId)
        inFlightRuns.delete(event.runId)
        switch (event.phase) {
          case 'success':
            clearActiveKey(ownerRunId)
            retainedFailures.delete(ownerRunId)
            void deleteEntry(mutationId, ownerRunId)
            // This run is the manual retry of whatever failed before it: the
            // server has accepted the write, so the entries those earlier runs
            // left for replay describe a write that already happened. Drop them,
            // or the next page load submits the operation twice.
            dropSupersededFailures(mutationId, identity, ownerRunId)
            return
          case 'error': {
            // In-process retries are exhausted by the time the runner reports
            // `error` — but cross-reload replays still get up to maxAttempts.
            // Leave the entry (and its key) in place unless we've already
            // replayed it maxAttempts times, or `isRetryable` says no later
            // attempt can succeed.
            const known = knownRuns.get(ownerRunId)
            const attempts = known?.attempts ?? 1
            const entry: QueueEntry = known ?? {
              v: PROTOCOL_VERSION,
              mutationId,
              runId: ownerRunId,
              variables: event.variables,
              attempts,
              enqueuedAt: Date.now(),
            }
            if (attempts >= maxAttempts || !retryable(event.error, entry)) {
              clearActiveKey(ownerRunId)
              retainedFailures.delete(ownerRunId)
              void deleteEntry(mutationId, ownerRunId)
              onReplayError(
                event.error ??
                  new Error(`[olas/mutation-queue] gave up on "${mutationId}/${ownerRunId}"`),
                entry,
              )
            } else if (identity !== undefined) {
              // The entry survives for a cross-load replay. Remember which
              // logical operation it belongs to so a later successful retry of
              // that operation can supersede it.
              retainedFailures.set(ownerRunId, { mutationId, identity })
            }
            return
          }
          case 'cancel':
            // Entry AND key stay in place — a page may reload mid-run and the
            // next startup's replay picks it up; a re-enqueue must collapse onto
            // the pending entry, not double-write.
            return
        }
      }

      return {
        async wrapMutate(context, next) {
          if (context.attempt === 0) {
            const entry = unwritten.get(context.runId)
            if (entry !== undefined) {
              unwritten.delete(context.runId)
              // `writeEntry` reports a failed write through `onWarn` and
              // resolves, so the run proceeds either way — only its
              // durability is lost.
              await writeEntry(entry)
            }
          }
          return next()
        },

        onMutation(event) {
          // Its own replays report here too; they are already on disk.
          if (event.origin === MUTATION_QUEUE_PLUGIN_NAME) return
          const mutationId = event.mutation.id
          if (mutationId === undefined || event.mutation.meta.persist !== true) return
          if (event.phase === 'start') onStart(event, mutationId)
          else onSettle(event, mutationId)
        },

        dispose() {
          disposed = true
          knownRuns.clear()
          runAlias.clear()
          runIdentity.clear()
          inFlightRuns.clear()
          retainedFailures.clear()
          unwritten.clear()
          // Release every pass parked in `waitForOnline` so the cross-tab replay
          // lock is handed back. `replayAll` re-checks `disposed` the moment the
          // wait returns. In-flight replays are cancelled by the engine when the
          // root's client disposes.
          for (const wake of onlineWaiters) wake()
          onlineWaiters.clear()
          // Trip every backoff sleeper so the per-mutationId driver's
          // `await sleep(...)` short-circuits and the outer loop bails on
          // `if (disposed) return`.
          for (const wake of backoffSleepers) wake()
          backoffSleepers.clear()
        },
      }
    },
  }
}

/**
 * Replay order within one mutation id. Monotonic `seq` first (assigned at
 * enqueue time, immune to clock drift), with `enqueuedAt` standing in for an
 * entry written before `seq` existed. Two tabs that start in the same
 * millisecond seed the same counter, so two unrelated entries can share a
 * `seq`: `runId` breaks the tie. It is random per run, stored in every entry
 * of every version, and unique within a mutation id (the storage key holds
 * it), so every tab sorts the same entries into the same order whatever order
 * its storage lists them in. Compared by code unit, not `localeCompare`, so
 * two tabs with different locales agree as well.
 */
function compareEntries(a: QueueEntry, b: QueueEntry): number {
  const bySeq = (a.seq ?? a.enqueuedAt) - (b.seq ?? b.enqueuedAt)
  if (bySeq !== 0) return bySeq
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0
}

/**
 * What the queue publishes on its devtools lane, through `host.debug`, in
 * development builds only: each replay attempt, its result, and each entry a
 * pass skipped without an attempt. Ids and counts only, never the variables,
 * so an event costs one small object.
 */
type LaneEvent =
  | { kind: 'replay:attempt'; mutationId: string; runId: string; attempt: number }
  | {
      kind: 'replay:result'
      mutationId: string
      runId: string
      attempt: number
      result: 'success' | 'retry-later' | 'max-attempts' | 'not-retryable' | 'aborted'
      error?: unknown
    }
  | {
      kind: 'replay:skipped'
      mutationId: string
      runId: string
      reason: 'in-flight' | 'not-registered' | 'not-persisted' | 'max-attempts' | 'ttl-expired'
    }

function defaultWarn(message: string, cause?: unknown): void {
  if (cause !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(message, cause)
  } else {
    // eslint-disable-next-line no-console
    console.warn(message)
  }
}

function defaultReplayError(err: unknown, entry: QueueEntry): void {
  // eslint-disable-next-line no-console
  console.error(`[olas/mutation-queue] replay failed for ${entry.mutationId}/${entry.runId}`, err)
}

// ─── Cross-tab replay coordination (T6.2) ───────────────────────────────────

const LEASE_TTL_MS = 30_000

type LockManagerLike = {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>
}

function getWebLocks(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks
  return locks !== undefined && typeof locks.request === 'function' ? locks : undefined
}

function getLeaseStorage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage
  } catch {
    // localStorage access can throw (SecurityError in a sandboxed iframe).
    return undefined
  }
}

/**
 * Best-effort localStorage lease used only when Web Locks is unavailable.
 * Returns true if this tab acquired (or refreshed a stale) lease. Last-writer-
 * wins with a re-read confirms ownership; a live lease from another tab
 * (younger than the TTL) makes us back off.
 */
function acquireLease(
  ls: Storage,
  lockName: string,
  leaseId: string,
  onWarn: (message: string, cause?: unknown) => void,
): boolean {
  const leaseKey = `${lockName}:lease`
  try {
    const now = Date.now()
    const raw = ls.getItem(leaseKey)
    if (raw !== null) {
      const ts = Number(raw.slice(0, raw.indexOf(':')))
      if (Number.isFinite(ts) && now - ts < LEASE_TTL_MS) {
        return false // a fresh lease is held by another tab
      }
    }
    ls.setItem(leaseKey, `${now}:${leaseId}`)
    return ls.getItem(leaseKey)?.endsWith(leaseId) ?? false
  } catch (cause) {
    onWarn(
      '[olas/mutation-queue] lease acquire failed; replaying without cross-tab coordination',
      cause,
    )
    return true // degrade to no-coordination rather than blocking replay
  }
}

function releaseLease(ls: Storage, lockName: string, leaseId: string): void {
  const leaseKey = `${lockName}:lease`
  try {
    if (ls.getItem(leaseKey)?.endsWith(leaseId)) ls.removeItem(leaseKey)
  } catch {
    /* best-effort */
  }
}
