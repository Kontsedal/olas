import { batch, type Signal, signal } from '../signals'
import { abortableSleep, isAbortError } from '../utils'
import { subscribeReconnect } from './focus-online'
import { structuralShare } from './structural-share'
import type { AsyncStatus, NetworkMode, RetryDelay, RetryPolicy, Snapshot } from './types'

export type EntryEvents = {
  onFetchStart?: () => void
  onFetchSuccess?: (durationMs: number) => void
  onFetchError?: (durationMs: number, error: unknown) => void
}

export type EntryOptions<T> = {
  fetcher: () => (signal: AbortSignal) => Promise<T>
  staleTime?: number
  initialData?: T | undefined
  initialUpdatedAt?: number | undefined
  retry?: RetryPolicy
  retryDelay?: RetryDelay
  networkMode?: NetworkMode
  structuralShare?: boolean
  events?: EntryEvents
  /**
   * Fired after a successful fetch result is written to `data`. Used by the
   * `QueryClient` to emit a plugin-visible `SetDataEvent` with
   * `source: 'fetch'` (devtools events live on `events` above). Distinct
   * from `events.onFetchSuccess`, which carries timing info for the
   * devtools bus.
   *
   * Privileged closure — set up by `ClientEntry` to call
   * `client.emitSetData(...)`, which already individually try/catches every
   * plugin via `callPlugin` and routes thrown exceptions through `onError`
   * with `kind: 'plugin'`. Not wrapped here; an exception escaping this
   * callback is a programming error in core (not a plugin) and SHOULD
   * surface so the bug is visible.
   */
  onSuccessData?: (data: T) => void
}

type SnapshotRecord<T> = {
  id: number
  prev: T | undefined
  live: boolean
}

/**
 * One cache entry's state machine. Owns the AsyncState signals, race
 * protection, retry loop, optimistic-update snapshot stack.
 *
 * Internal — not exported from the public surface.
 */
export class Entry<T> {
  readonly data: Signal<T | undefined>
  readonly error: Signal<unknown | undefined> = signal(undefined)
  readonly status: Signal<AsyncStatus>
  readonly isLoading: Signal<boolean> = signal(false)
  readonly isFetching: Signal<boolean> = signal(false)
  readonly lastUpdatedAt: Signal<number | undefined>
  readonly hasPendingMutations: Signal<boolean> = signal(false)
  readonly isStale: Signal<boolean> = signal(true)

  fetcherProvider: () => (signal: AbortSignal) => Promise<T>
  private staleTime: number
  private retry: RetryPolicy
  private retryDelay: RetryDelay
  private networkMode: NetworkMode
  private structuralShareEnabled: boolean
  private currentFetchId = 0
  private currentAbort: AbortController | null = null
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private snapshots: Array<SnapshotRecord<T>> = []
  private nextSnapshotId = 0
  private disposed = false
  /** Subscribers to reconnect — installed lazily when a deferred fetch lands. */
  private reconnectUnsub: (() => void) | null = null
  /**
   * Set of deferred-fetch resolvers waiting for reconnect (online mode).
   * Stored at `unknown` to keep `Entry<T>` covariant in `T` — same trick as
   * `onSuccessData`. Each resolver is fed the same value from
   * `applySuccess`, which is `T`, then cast at the fan-out call site.
   */
  private deferredResolvers: Array<{
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }> = []
  private readonly events: EntryEvents
  // Stored at `unknown` (not `T`) to keep `Entry<T>` covariant in `T`. The
  // callback only forwards the value through; Entry never inspects it.
  private readonly onSuccessData: ((data: unknown) => void) | undefined
  private fetchStartTime = 0
  /**
   * Promises returned by `firstValue()` that haven't settled. Rejected on
   * `dispose()` so awaiters (most notably `prefetch` and `subscription.firstValue`)
   * don't hang when the controller tree is torn down mid-fetch.
   */
  private pendingFirstValueRejects: Array<(err: unknown) => void> = []

  constructor(options: EntryOptions<T>) {
    this.fetcherProvider = options.fetcher
    this.staleTime = options.staleTime ?? 0
    this.retry = options.retry ?? 0
    this.retryDelay = options.retryDelay ?? 1000
    this.networkMode = options.networkMode ?? 'online'
    this.structuralShareEnabled = options.structuralShare ?? true
    this.events = options.events ?? {}
    this.onSuccessData = options.onSuccessData as ((data: unknown) => void) | undefined
    this.data = signal<T | undefined>(options.initialData)
    if (options.initialData !== undefined) {
      this.status = signal<AsyncStatus>('success')
      // For hydrated data, derive `isStale` from the *actual* age of the
      // payload, not the timer alone — otherwise a payload older than
      // `staleTime` would read `isStale === false` until the (fresh, full-
      // length) timer fires. `isStaleNow()` already does this correctly for
      // the subscribe-time refetch check; mirror that here for the signal.
      if (this.staleTime === 0) {
        this.isStale.set(true)
      } else {
        const last = options.initialUpdatedAt
        const alreadyStale = last === undefined || Date.now() - last >= this.staleTime
        this.isStale.set(alreadyStale)
        // Only schedule a timer if the data isn't already stale. If it is,
        // there's nothing to wait for.
        if (!alreadyStale) {
          const remaining = this.staleTime - (Date.now() - (last as number))
          this.staleTimer = setTimeout(() => {
            this.staleTimer = null
            if (!this.disposed) this.isStale.set(true)
          }, remaining)
        }
      }
    } else {
      this.status = signal<AsyncStatus>('idle')
    }
    this.lastUpdatedAt = signal<number | undefined>(options.initialUpdatedAt)
  }

  startFetch(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Entry disposed'))
    }
    // `online` mode: defer until reconnect when the browser thinks we're
    // offline. Don't touch status — the UI keeps showing last-known data.
    // `always` / `offlineFirst` proceed to the fetcher; `offlineFirst` will
    // re-handle a network rejection inside the catch path.
    if (this.networkMode === 'online' && this.isOffline()) {
      return this.scheduleDeferredFetch()
    }
    const myId = ++this.currentFetchId
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort

    const previouslyHadData = this.data.peek() !== undefined
    batch(() => {
      this.status.set('pending')
      this.isFetching.set(true)
      this.isLoading.set(!previouslyHadData)
    })

    this.fetchStartTime = Date.now()
    try {
      this.events.onFetchStart?.()
    } catch {
      // devtools handlers must not break the program.
    }

    return this.runWithRetry(myId, abort)
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  }

  private scheduleDeferredFetch(): Promise<T> {
    // Lazy-install one reconnect listener for the entry. Cleared on dispose
    // and on the first successful drain. Each call appends a fresh resolver.
    if (this.reconnectUnsub === null) {
      this.reconnectUnsub = subscribeReconnect(() => this.drainDeferred())
    }
    return new Promise<T>((resolve, reject) => {
      this.deferredResolvers.push({
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
  }

  private drainDeferred(): void {
    if (this.deferredResolvers.length === 0) return
    if (this.disposed) return
    const pending = this.deferredResolvers
    this.deferredResolvers = []
    // One real fetch fans out to every pending resolver. Tearing down the
    // reconnect listener avoids accumulating listeners across many deferrals.
    if (this.reconnectUnsub !== null) {
      this.reconnectUnsub()
      this.reconnectUnsub = null
    }
    this.startFetch().then(
      (value) => {
        for (const p of pending) p.resolve(value)
      },
      (err) => {
        for (const p of pending) p.reject(err)
      },
    )
  }

  private async runWithRetry(myId: number, abort: AbortController): Promise<T> {
    let attempt = 0
    while (true) {
      if (myId !== this.currentFetchId || this.disposed) {
        throw new DOMException('Superseded', 'AbortError')
      }
      try {
        const fetcher = this.fetcherProvider()
        const result = await fetcher(abort.signal)
        if (myId !== this.currentFetchId || this.disposed) {
          throw new DOMException('Superseded', 'AbortError')
        }
        return this.applySuccess(result)
      } catch (err) {
        if (myId !== this.currentFetchId || this.disposed || isAbortError(err)) {
          throw err
        }
        if (!this.shouldRetry(attempt, err)) {
          return this.applyFailure(err)
        }
        const delay = this.computeDelay(attempt)
        await abortableSleep(delay, abort.signal)
        attempt += 1
      }
    }
  }

  private shouldRetry(attempt: number, err: unknown): boolean {
    const retry = this.retry
    if (retry === 0) return false
    if (typeof retry === 'number') return attempt < retry
    return retry(attempt, err)
  }

  private computeDelay(attempt: number): number {
    const d = this.retryDelay
    return typeof d === 'function' ? d(attempt) : d
  }

  private applySuccess(result: T): T {
    // Structurally share with the previous value so unchanged sub-trees
    // keep their `===` identity. Downstream `computed`s and React snapshots
    // stop thrashing on no-op refetches. Bails on Maps/Sets/class instances
    // — see `structural-share.ts`. Disabled per-query via `structuralShare:
    // false` for large payloads where the O(payload) walk costs more than
    // the re-render savings.
    const prev = this.data.peek() as T | undefined
    const shared =
      prev === undefined || !this.structuralShareEnabled ? result : structuralShare(prev, result)
    batch(() => {
      this.data.set(shared)
      this.error.set(undefined)
      this.status.set('success')
      this.isLoading.set(false)
      this.isFetching.set(false)
      this.lastUpdatedAt.set(Date.now())
      this.isStale.set(this.staleTime === 0)
    })
    if (this.staleTime > 0) this.scheduleStaleness()
    try {
      this.events.onFetchSuccess?.(Date.now() - this.fetchStartTime)
    } catch {
      // devtools handlers must not break the program.
    }
    this.onSuccessData?.(shared)
    return shared
  }

  private applyFailure(err: unknown): never {
    batch(() => {
      this.error.set(err)
      this.status.set('error')
      this.isLoading.set(false)
      this.isFetching.set(false)
    })
    try {
      this.events.onFetchError?.(Date.now() - this.fetchStartTime, err)
    } catch {
      // devtools handlers must not break the program.
    }
    throw err
  }

  private scheduleStaleness(): void {
    if (this.staleTimer != null) clearTimeout(this.staleTimer)
    if (this.staleTime > 0) {
      this.staleTimer = setTimeout(() => {
        this.staleTimer = null
        if (!this.disposed) this.isStale.set(true)
      }, this.staleTime)
    }
  }

  refetch(): Promise<T> {
    return this.startFetch()
  }

  /**
   * Apply a server-supplied data + timestamp without going through the
   * fetcher path. Used by streaming SSR hydration: each `<Suspense>` boundary
   * that resolves on the server pushes its entry's data to the client, and
   * the client routes it through here so the entry transitions to `success`
   * without burning the user's fetcher.
   *
   * Distinct from `setData`: no Snapshot returned (no rollback semantics —
   * this is canonical data, not an optimistic patch), no
   * `hasPendingMutations` flip, and `lastUpdatedAt` honors the supplied
   * server timestamp instead of `Date.now()`. Also bumps `currentFetchId`
   * so any in-flight fetch supersedes itself rather than overwriting the
   * fresher hydrated value.
   */
  applyHydration(data: T, lastUpdatedAt: number): void {
    if (this.disposed) return
    // Bump fetch id: an inflight fetcher will now lose the supersede check
    // in `runWithRetry` and won't write its (likely-stale) result.
    this.currentFetchId += 1
    this.currentAbort?.abort()
    this.currentAbort = null
    if (this.staleTimer !== null) {
      clearTimeout(this.staleTimer)
      this.staleTimer = null
    }
    const alreadyStale = this.staleTime === 0 || Date.now() - lastUpdatedAt >= this.staleTime
    batch(() => {
      this.data.set(data)
      this.error.set(undefined)
      this.status.set('success')
      this.isLoading.set(false)
      this.isFetching.set(false)
      this.lastUpdatedAt.set(lastUpdatedAt)
      this.isStale.set(alreadyStale)
    })
    if (!alreadyStale && this.staleTime > 0) {
      const remaining = this.staleTime - (Date.now() - lastUpdatedAt)
      this.staleTimer = setTimeout(() => {
        this.staleTimer = null
        if (!this.disposed) this.isStale.set(true)
      }, remaining)
    }
    this.onSuccessData?.(data)
    // Resolve any awaiters parked in firstValue / promise.
    if (this.pendingFirstValueRejects.length > 0) {
      // First-value awaiters are subscribed to `this.status`; the batched
      // `status.set('success')` above wakes them through the normal
      // subscribe path. We don't need to do anything else here.
    }
  }

  invalidate(): Promise<T> {
    if (this.staleTimer != null) {
      clearTimeout(this.staleTimer)
      this.staleTimer = null
    }
    this.isStale.set(true)
    return this.startFetch()
  }

  reset(): void {
    if (this.disposed) return
    batch(() => {
      this.error.set(undefined)
      this.status.set(this.data.peek() !== undefined ? 'success' : 'idle')
    })
  }

  setData(updater: (prev: T | undefined) => T): Snapshot {
    if (this.disposed) {
      return { rollback: () => {}, finalize: () => {} }
    }
    const prev = this.data.peek()
    const next = updater(prev)
    const id = this.nextSnapshotId++
    const record: SnapshotRecord<T> = { id, prev, live: true }
    this.snapshots.push(record)

    batch(() => {
      this.data.set(next)
      if (this.status.peek() === 'idle' || this.status.peek() === 'pending') {
        this.status.set('success')
      }
      this.lastUpdatedAt.set(Date.now())
      this.hasPendingMutations.set(true)
    })

    return {
      rollback: () => {
        if (!record.live || this.disposed) return
        record.live = false
        batch(() => {
          this.data.set(record.prev as T)
          this.snapshots = this.snapshots.filter((s) => s.id !== id)
          const anyLive = this.snapshots.some((s) => s.live)
          this.hasPendingMutations.set(anyLive)
        })
      },
      finalize: () => {
        if (!record.live || this.disposed) return
        record.live = false
        this.snapshots = this.snapshots.filter((s) => s.id !== id)
        if (!this.snapshots.some((s) => s.live)) {
          this.hasPendingMutations.set(false)
        }
      },
    }
  }

  firstValue(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new DOMException('Entry disposed', 'AbortError'))
    }
    if (this.status.peek() === 'success') {
      return Promise.resolve(this.data.peek() as T)
    }
    if (this.status.peek() === 'error') {
      return Promise.reject(this.error.peek())
    }
    return new Promise<T>((resolve, reject) => {
      const tracked = (err: unknown): void => {
        this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
        reject(err)
      }
      this.pendingFirstValueRejects.push(tracked)
      const unsub = this.status.subscribe((s) => {
        if (s === 'success') {
          unsub()
          this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
          resolve(this.data.peek() as T)
        } else if (s === 'error') {
          unsub()
          tracked(this.error.peek())
        }
      })
    })
  }

  /**
   * True iff data is older than `staleTime` (or no data has been fetched yet).
   * Used by the query client to decide whether to refetch on subscribe.
   */
  isStaleNow(): boolean {
    const last = this.lastUpdatedAt.peek()
    if (last === undefined) return true
    return Date.now() - last >= this.staleTime
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.staleTimer != null) {
      clearTimeout(this.staleTimer)
      this.staleTimer = null
    }
    this.currentAbort?.abort()
    this.currentAbort = null
    if (this.reconnectUnsub !== null) {
      this.reconnectUnsub()
      this.reconnectUnsub = null
    }
    if (this.deferredResolvers.length > 0) {
      const disposed = new DOMException('Entry disposed', 'AbortError')
      const pending = this.deferredResolvers
      this.deferredResolvers = []
      for (const p of pending) p.reject(disposed)
    }
    if (this.pendingFirstValueRejects.length > 0) {
      const disposed = new DOMException('Entry disposed', 'AbortError')
      const rejects = this.pendingFirstValueRejects
      this.pendingFirstValueRejects = []
      for (const fn of rejects) fn(disposed)
    }
  }
}
