import {
  lookupRegisteredMutation,
  type MutationEnqueueEvent,
  type MutationSettleEvent,
  type QueryClientPlugin,
} from '@kontsedal/olas-core'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { PROTOCOL_VERSION, type QueueEntry } from './protocol'

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
export function mutationQueuePlugin(options: MutationQueueOptions): QueryClientPlugin {
  const { adapter, keyPrefix } = options
  const maxAttempts = options.maxAttempts ?? 5
  const onReplayError = options.onReplayError ?? defaultReplayError
  const onWarn = options.onWarn ?? defaultWarn

  if (typeof keyPrefix !== 'string' || keyPrefix.length === 0) {
    throw new Error('[olas/mutation-queue] keyPrefix is required.')
  }

  // Per-runId attempt counter so a replay that itself enqueues bumps the
  // attempts counter rather than allocating a fresh slot.
  const knownRuns = new Map<string, QueueEntry>()
  // Per-mutationId serial replay queue — kicks off on `init` and drains
  // before yielding back to the runtime. We don't block init waiting for
  // replays; they run in the background and call `onReplayError` if any
  // settle in failure.
  let disposed = false

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

  const writeEntry = async (entry: QueueEntry): Promise<void> => {
    try {
      const json = JSON.stringify(entry)
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
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        (parsed as { v?: unknown }).v !== PROTOCOL_VERSION ||
        typeof (parsed as { mutationId?: unknown }).mutationId !== 'string' ||
        typeof (parsed as { runId?: unknown }).runId !== 'string' ||
        typeof (parsed as { attempts?: unknown }).attempts !== 'number' ||
        typeof (parsed as { enqueuedAt?: unknown }).enqueuedAt !== 'number'
      ) {
        return null
      }
      return parsed as QueueEntry
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
    try {
      await registered.mutate(entry.variables, abort.signal)
      // Success — drop the entry.
      await deleteEntry(entry.mutationId, entry.runId)
    } catch (err) {
      // Single replay attempt failed. If this was the last allowed
      // attempt, drop and surface; otherwise leave the entry in place
      // (with the bumped attempts counter) so the next page load tries
      // again.
      if (next.attempts >= maxAttempts) {
        await deleteEntry(entry.mutationId, entry.runId)
        onReplayError(err, next)
      }
    }
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
    await waitForOnline()
    if (disposed) return
    const byMutation = new Map<string, QueueEntry[]>()
    for (const e of entries) {
      const bucket = byMutation.get(e.mutationId)
      if (bucket === undefined) byMutation.set(e.mutationId, [e])
      else bucket.push(e)
    }
    const tasks: Promise<void>[] = []
    for (const bucket of byMutation.values()) {
      bucket.sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      tasks.push(
        (async () => {
          for (const entry of bucket) {
            if (disposed) return
            await replayEntry(entry)
          }
        })(),
      )
    }
    await Promise.all(tasks)
  }

  return {
    init() {
      // Kick off replay async — don't block the root construction. Errors
      // route through `onReplayError` per entry.
      replayAll().catch((err) => {
        onWarn('[olas/mutation-queue] replay failed', err)
      })
    },

    onMutationEnqueue(event: MutationEnqueueEvent) {
      const entry: QueueEntry = {
        v: PROTOCOL_VERSION,
        mutationId: event.mutationId,
        runId: event.runId,
        variables: event.variables,
        attempts: event.attempt,
        enqueuedAt: Date.now(),
      }
      // Fire and forget — `runOnChain` ensures a subsequent delete waits
      // on this write, so the persist-after-delete race can't happen even
      // with a sync settle.
      void writeEntry(entry)
    },

    onMutationSettle(event: MutationSettleEvent) {
      switch (event.outcome) {
        case 'success':
          void deleteEntry(event.mutationId, event.runId)
          return
        case 'error': {
          // In-process retries are exhausted by the time the runner emits
          // `error` — but cross-reload replays still get up to maxAttempts.
          // Leave the entry in place unless we've already replayed it
          // maxAttempts times.
          const known = knownRuns.get(event.runId)
          const attempts = known?.attempts ?? 1
          if (attempts >= maxAttempts) {
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
          // Leave entry in place — page may reload mid-run, and the next
          // init's replay should pick it up.
          return
      }
    },

    dispose() {
      disposed = true
      knownRuns.clear()
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
