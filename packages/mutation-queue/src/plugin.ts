import {
  lookupRegisteredMutation,
  type MutationEnqueueEvent,
  type MutationSettleEvent,
  type Query,
  type QueryClientPlugin,
} from '@kontsedal/olas-core'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { PROTOCOL_VERSION, type QueueEntry } from './protocol'

/**
 * Handle passed to `onReplaySettle` so an app can reconcile its cache after a
 * queued mutation replays successfully (a reload / reconnect replay writes
 * server truth, but no local query knows to refetch). Without calling this,
 * UIs stay stale until their own `staleTime` lapses.
 */
export type ReplaySettleApi = {
  /**
   * Invalidate a query's cached entry for `keyArgs` so subscribers refetch.
   * Delegates to the query's own `invalidate(...)` (all bound roots), so it
   * works whether or not the query carries an explicit `queryId`.
   */
  invalidate(query: Query<any, any>, keyArgs?: readonly unknown[]): void
}

/**
 * Options for `mutationQueuePlugin(...)`. SPEC §13.3.
 *
 * - `adapter` — the underlying durable store. `localStorageAdapter` from
 *   `@kontsedal/olas-persist` is the typical default; `indexedDbAdapter`
 *   when payloads are large or async write is preferred.
 * - `keyPrefix` — namespace prefix in storage. Required to keep multiple
 *   apps on the same origin from colliding. Recommended shape:
 *   `'<my-app>/mutations/v1'`.
 * - `maxAttempts` — bound on replay attempts per entry. After exhaustion
 *   the entry is dropped from storage and `onReplayError` fires with the
 *   final error. Defaults to `5`.
 * - `onReplayError` — called when a replayed mutation throws (after
 *   `maxAttempts`) OR when a queue entry references a `mutationId` whose
 *   module hasn't been imported yet. The handler is the integration point
 *   for telemetry / user-facing error toasts on lost mutations.
 * - `onWarn` — soft conditions: malformed entry in storage, serialization
 *   failure (variables not structured-cloneable). Default: `console.warn`.
 */
export type MutationQueueOptions = {
  adapter: StorageAdapter
  keyPrefix: string
  maxAttempts?: number
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
  /** Cap on the exponential backoff. Defaults to `60_000` (60s). */
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
   * Called after a queued mutation **replays successfully** on init /
   * reconnect, with the entry, the mutate's return value, and a
   * {@link ReplaySettleApi} for cache reconciliation. A replay writes server
   * truth outside any live query's knowledge — without invalidating the
   * affected queries here, subscribers keep showing stale data until their
   * own `staleTime` lapses. Errors thrown by the handler are swallowed
   * (routed to `onWarn`) so a buggy reconciler can't break replay.
   */
  onReplaySettle?: (entry: QueueEntry, result: unknown, api: ReplaySettleApi) => void
  onWarn?: (message: string, cause?: unknown) => void
}

/**
 * `QueryClientPlugin` that persists `defineMutation({ persist: true })` runs
 * to a `StorageAdapter` and replays pending entries on `init`.
 *
 * Lifecycle per run:
 *  1. `onMutationEnqueue` → write `QueueEntry` to storage.
 *  2. `onMutationSettle({ outcome: 'success' })` → delete entry. The
 *     server accepted, no replay needed.
 *  3. `onMutationSettle({ outcome: 'error' })` → delete entry IF
 *     `attempts >= maxAttempts`, else leave it and let the next page load
 *     trigger another attempt. (Within a single page load, in-process
 *     retries are handled by core's `spec.retry` policy.)
 *  4. `onMutationSettle({ outcome: 'cancelled' })` → leave entry in place.
 *     A page reload mid-run looks indistinguishable from explicit cancel
 *     at the plugin layer; the next `init` replays.
 *
 * On `init`:
 *  - List all keys under `keyPrefix`, parse each as a `QueueEntry`.
 *  - Group by `mutationId`; within each group sort by `enqueuedAt`.
 *  - For each entry, look up the registered mutation. If absent (module
 *    not imported yet), call `onReplayError({ kind: 'unknown-mutation' })`
 *    and leave in storage. If present, run `mutate(variables, signal)`
 *    serially per mutationId.
 *
 * **Idempotency** is the consumer's responsibility — include an
 * `idempotencyKey` in your variables and have the server dedupe by it.
 * The queue makes no attempt at exactly-once delivery; it gives at-least-
 * once-until-success.
 *
 * **Variables MUST be JSON-serializable.** Functions / symbols / class
 * instances throw at enqueue time; the throw is reported via `onWarn` and
 * the in-process run continues normally (server may still accept). The
 * entry is just not durable in that case.
 */
export function mutationQueuePlugin(
  options: MutationQueueOptions,
): QueryClientPlugin & { replayNow(): Promise<void> } {
  const { adapter, keyPrefix } = options
  const maxAttempts = options.maxAttempts ?? 5
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

  /**
   * Monotonic per-tab sequence counter. Persisted entries take this as their
   * `seq` so replay ordering survives wall-clock drift. **Seeded from
   * `Date.now()` at construction** so a post-restart enqueue always sorts
   * after every pre-restart entry WITHOUT waiting to read the disk — the old
   * design primed this from disk inside `replayAll` (async), so an enqueue
   * that raced init got `seq` 1 and jumped ahead of prior-session entries
   * (T6.2). The `replayAll` priming below is now just a belt-and-suspenders
   * bump for the rare same-millisecond cross-tab case; it can only raise the
   * counter, never lower it.
   */
  let seqCounter = Date.now()

  /**
   * Map of active `idempotencyKey` → `runId`. When `dedupeBy` returns a
   * key that matches an in-flight entry, the second enqueue collapses
   * onto the first (no new write). Cleared on settle (success/error after
   * exhaustion, NOT cancelled).
   */
  const activeKeys = new Map<string, string>()

  // Per-runId attempt counter so a replay that itself enqueues bumps the
  // attempts counter rather than allocating a fresh slot.
  const knownRuns = new Map<string, QueueEntry>()
  // Per-mutationId serial replay queue — kicks off on `init` and drains
  // before yielding back to the runtime. We don't block init waiting for
  // replays; they run in the background and call `onReplayError` if any
  // settle in failure.
  let disposed = false
  // Guards concurrent replay runs (init / `online` / `replayNow` all funnel
  // through `runReplay`) so a set of entries isn't replayed twice at once.
  let replaying = false
  // The `online` reconnect listener — in-session failures retry when the
  // network comes back, not only on reload (T6.2). Removed on dispose.
  let onlineHandler: (() => void) | null = null
  // Outstanding replay AbortControllers — `dispose()` aborts each so a tab
  // close mid-replay doesn't leak the request. The controller is added to
  // the set just before `mutate(...)` runs and removed in `finally`.
  const inFlightReplays = new Set<AbortController>()
  // Outstanding backoff sleepers — `dispose()` triggers each so the
  // per-mutationId driver short-circuits the wait.
  const backoffSleepers = new Set<() => void>()

  // Tracks in-flight writes per runId so a fast `delete` can't race ahead
  // of its preceding `write` (the persist-after-delete bug). Callers that
  // await sequentially (e.g. `replayEntry`) pay zero overhead — the write
  // has cleared its slot by the time the delete starts. Callers that fire
  // both fire-and-forget (the `onMutationEnqueue` → `onMutationSettle`
  // path on a synchronous mutation) get ordered correctly because the
  // entry is registered before `writeEntry`'s first `await`.
  const pendingWrites = new Map<string, Promise<unknown>>()

  const entryKey = (mutationId: string, runId: string): string =>
    `${keyPrefix}/${mutationId}/${runId}`

  /** Drop the dedupe key mapped to `runId` (we don't index runId→key). */
  const clearActiveKey = (runId: string): void => {
    for (const [k, v] of activeKeys) {
      if (v === runId) {
        activeKeys.delete(k)
        break
      }
    }
  }

  /** Passed to `onReplaySettle` so apps can invalidate affected queries. */
  const replaySettleApi: ReplaySettleApi = {
    invalidate(query, keyArgs) {
      try {
        query.invalidate(...((keyArgs ?? []) as unknown[]))
      } catch (cause) {
        onWarn('[olas/mutation-queue] onReplaySettle invalidate failed', cause)
      }
    },
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
          'variables likely not JSON-serializable. The in-process run continues, but the entry is not durable.',
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

  const parseEntry = (raw: unknown): QueueEntry | null => {
    if (typeof raw !== 'string') return null
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object') return null
      const obj = parsed as Record<string, unknown>
      const version = typeof obj.v === 'number' ? obj.v : undefined
      if (version !== PROTOCOL_VERSION) {
        // Try migrator first; if it returns null (or none configured), drop.
        if (migrate !== undefined && version !== undefined) {
          try {
            const migrated = migrate(parsed, version)
            if (migrated !== null) return migrated
          } catch (err) {
            onWarn('[olas/mutation-queue] migrate threw; dropping entry', err)
          }
        }
        return null
      }
      if (
        typeof obj.mutationId !== 'string' ||
        typeof obj.runId !== 'string' ||
        typeof obj.attempts !== 'number' ||
        typeof obj.enqueuedAt !== 'number'
      ) {
        return null
      }
      return obj as unknown as QueueEntry
    } catch {
      return null
    }
  }

  /**
   * List every persisted entry under `keyPrefix`. The `StorageAdapter`
   * contract doesn't include `keys()`, so we attempt a structural cast to
   * an `Iterable`-shaped adapter; falls back to an empty list when the
   * adapter doesn't expose one. Concrete adapters (`localStorageAdapter`,
   * `indexedDbAdapter`) ship a `keys()` extension for this purpose.
   */
  const listEntries = async (): Promise<QueueEntry[]> => {
    const ext = adapter as StorageAdapter & {
      keys?: () => Iterable<string> | Promise<Iterable<string>>
    }
    if (typeof ext.keys !== 'function') {
      onWarn(
        '[olas/mutation-queue] storage adapter has no keys() method; replay disabled. ' +
          'Use localStorageAdapter / indexedDbAdapter from @kontsedal/olas-persist, ' +
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
        if (parsed === null) {
          onWarn(`[olas/mutation-queue] dropping malformed entry at ${key}`)
          try {
            await adapter.delete(key)
          } catch {
            /* best-effort cleanup; the warn above is the primary signal */
          }
          continue
        }
        entries.push(parsed)
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
    const registered = lookupRegisteredMutation(entry.mutationId)
    if (registered === undefined) {
      // Module hasn't been imported — leave entry in place and surface so
      // the user knows it's stuck. They can either import the module to
      // unstick it or delete the entry from storage.
      onReplayError(
        new Error(
          `[olas/mutation-queue] no registered mutation for "${entry.mutationId}"; ` +
            'replay skipped. Ensure the module that calls defineMutation(...) is imported.',
        ),
        entry,
      )
      return
    }
    if (entry.attempts >= maxAttempts) {
      // Already exhausted on a previous load; drop and surface.
      await deleteEntry(entry.mutationId, entry.runId)
      onReplayError(
        new Error(
          `[olas/mutation-queue] giving up on "${entry.mutationId}/${entry.runId}" after ${entry.attempts} attempts.`,
        ),
        entry,
      )
      return
    }
    // Bump the attempts counter durably BEFORE running so a hard crash
    // during the mutate doesn't loop forever on the same entry.
    const next: QueueEntry = { ...entry, attempts: entry.attempts + 1 }
    await writeEntry(next)
    const abort = new AbortController()
    inFlightReplays.add(abort)
    try {
      const result = await registered.mutate(entry.variables, abort.signal)
      // Success — drop the entry.
      await deleteEntry(entry.mutationId, entry.runId)
      // Let the app reconcile its cache (a replay wrote server truth outside
      // any live query's knowledge). Swallow handler throws (T6.2).
      if (onReplaySettle !== undefined) {
        try {
          onReplaySettle(entry, result, replaySettleApi)
        } catch (cause) {
          onWarn('[olas/mutation-queue] onReplaySettle threw', cause)
        }
      }
    } catch (err) {
      // Single replay attempt failed. If this was the last allowed
      // attempt, drop and surface; otherwise leave the entry in place
      // (with the bumped attempts counter) so the next page load tries
      // again. Fire `onReplayAttempt` either way so consumers can show
      // "retrying" indicators.
      if (next.attempts >= maxAttempts) {
        await deleteEntry(entry.mutationId, entry.runId)
        onReplayError(err, next)
      } else if (onReplayAttempt !== undefined) {
        try {
          onReplayAttempt(err, next)
        } catch {
          /* don't let a buggy onReplayAttempt break replay */
        }
      }
    } finally {
      inFlightReplays.delete(abort)
    }
  }

  /**
   * Sleep that resolves early when `bail()` returns true. Used by the
   * per-mutationId driver to short-circuit backoff windows when the
   * plugin disposes mid-wait — without this, `dispose()` would still
   * have to wait out the longest backoff to escape.
   */
  const sleep = (ms: number, bail: () => boolean): Promise<void> => {
    return new Promise((resolve) => {
      if (bail()) {
        resolve()
        return
      }
      const t = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)
      const tick = () => {
        if (bail()) {
          clearTimeout(t)
          cleanup()
          resolve()
        }
      }
      const interval = setInterval(tick, 100)
      const cleanup = () => {
        clearInterval(interval)
        backoffSleepers.delete(cleanup)
      }
      backoffSleepers.add(cleanup)
    })
  }

  /**
   * Wait until the tab reports as online. Without this gate, replays burn
   * `maxAttempts` on `fetch` failures the user can't see and the queue
   * silently empties. In environments without `navigator` (Node SSR, tests
   * mocking the global), assume online and proceed.
   */
  const waitForOnline = (): Promise<void> => {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      return Promise.resolve()
    }
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const onOnline = () => {
        window.removeEventListener('online', onOnline)
        resolve()
      }
      window.addEventListener('online', onOnline)
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
      // Prefer monotonic `seq` (assigned at enqueue time, immune to clock
      // drift). Fall back to `enqueuedAt` for legacy entries without a
      // `seq` stamp.
      bucket.sort((a, b) => {
        const aS = typeof a.seq === 'number' ? a.seq : a.enqueuedAt
        const bS = typeof b.seq === 'number' ? b.seq : b.enqueuedAt
        return aS - bS
      })
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
              await sleep(delay, () => disposed)
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

  return {
    init() {
      // Retry in-session when the network returns — not only on reload (T6.2).
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        onlineHandler = () => {
          void runReplay()
        }
        window.addEventListener('online', onlineHandler)
      }
      // Kick off the initial replay async — don't block root construction.
      // Errors route through `onReplayError` per entry.
      void runReplay()
    },

    onMutationEnqueue(event: MutationEnqueueEvent) {
      const idempotencyKey = dedupeBy?.(event.mutationId, event.variables)
      if (idempotencyKey !== undefined) {
        const fullKey = `${event.mutationId}:${idempotencyKey}`
        const existingRunId = activeKeys.get(fullKey)
        if (existingRunId !== undefined && existingRunId !== event.runId) {
          // Already in flight under a different runId — collapse. The
          // in-process run continues (consumer's promise resolves with
          // whatever this attempt produces), but we don't write a second
          // durable entry. The server's dedupe is the canonical gate.
          return
        }
        activeKeys.set(fullKey, event.runId)
      }
      seqCounter += 1
      const entry: QueueEntry = {
        v: PROTOCOL_VERSION,
        mutationId: event.mutationId,
        runId: event.runId,
        variables: event.variables,
        attempts: event.attempt,
        enqueuedAt: Date.now(),
        seq: seqCounter,
        idempotencyKey,
      }
      // Fire-and-forget: `onMutationEnqueue` is a synchronous plugin hook, so
      // we can't await the durable write here. `pendingWrites` still orders a
      // later delete after this write (no persist-after-delete race). Loss
      // window: if the durable write REJECTS (quota, or an IDB commit abort now
      // that the adapter surfaces those — T6.1) the in-process run still
      // proceeds and the failure is reported via `onWarn`, but a reload before
      // the run completes loses that mutation. Inherent to a sync enqueue hook —
      // see the README "best-effort" note (T6.2).
      void writeEntry(entry)
    },

    onMutationSettle(event: MutationSettleEvent) {
      // The dedupe key is released ONLY when the durable entry is dropped
      // (success, or error after exhaustion). On a non-terminal error or a
      // 'cancelled' the entry stays pending replay, so its key must stay
      // active — else a re-enqueue writes a SECOND durable entry for the same
      // logical mutation (T6.2). We don't index runId→key, so walk on drop.
      switch (event.outcome) {
        case 'success':
          clearActiveKey(event.runId)
          void deleteEntry(event.mutationId, event.runId)
          return
        case 'error': {
          // In-process retries are exhausted by the time the runner emits
          // `error` — but cross-reload replays still get up to maxAttempts.
          // Leave the entry (and its key) in place unless we've already
          // replayed it maxAttempts times.
          const known = knownRuns.get(event.runId)
          const attempts = known?.attempts ?? 1
          if (attempts >= maxAttempts) {
            clearActiveKey(event.runId)
            void deleteEntry(event.mutationId, event.runId)
            onReplayError(
              event.error ??
                new Error(`[olas/mutation-queue] gave up on "${event.mutationId}/${event.runId}"`),
              known ?? {
                v: PROTOCOL_VERSION,
                mutationId: event.mutationId,
                runId: event.runId,
                variables: undefined,
                attempts,
                enqueuedAt: Date.now(),
              },
            )
          }
          return
        }
        case 'cancelled':
          // Entry AND key stay in place — a page may reload mid-run and the
          // next init's replay picks it up; a re-enqueue must collapse onto
          // the pending entry, not double-write.
          return
      }
    },

    replayNow(): Promise<void> {
      return runReplay()
    },

    dispose() {
      disposed = true
      if (onlineHandler !== null && typeof window !== 'undefined') {
        window.removeEventListener('online', onlineHandler)
        onlineHandler = null
      }
      knownRuns.clear()
      // Abort every in-flight replay so a tab close mid-mutate doesn't
      // leak the network request. Mutations that respect their signal
      // (the documented contract) will reject with AbortError — caught
      // inside `replayEntry` as a regular failure path.
      for (const controller of inFlightReplays) controller.abort()
      inFlightReplays.clear()
      // Trip every backoff sleeper so the per-mutationId driver's
      // `await sleep(...)` short-circuits and the outer loop bails on
      // `if (disposed) return`.
      for (const wake of backoffSleepers) wake()
      backoffSleepers.clear()
    },
  }
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
