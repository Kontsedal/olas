import { batch, type Signal, signal } from '../signals'
import { abortableSleep, isAbortError } from '../utils'
import type { AsyncStatus, RetryDelay, RetryPolicy, Snapshot } from './types'

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
  private currentFetchId = 0
  private currentAbort: AbortController | null = null
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private snapshots: Array<SnapshotRecord<T>> = []
  private nextSnapshotId = 0
  private disposed = false
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
    batch(() => {
      this.data.set(result)
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
    this.onSuccessData?.(result)
    return result
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
    if (this.pendingFirstValueRejects.length > 0) {
      const disposed = new DOMException('Entry disposed', 'AbortError')
      const rejects = this.pendingFirstValueRejects
      this.pendingFirstValueRejects = []
      for (const fn of rejects) fn(disposed)
    }
  }
}
