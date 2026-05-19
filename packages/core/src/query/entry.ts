import { batch, type Signal, signal } from '../signals'
import { isAbortError } from '../utils'
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
  private fetchStartTime = 0

  constructor(options: EntryOptions<T>) {
    this.fetcherProvider = options.fetcher
    this.staleTime = options.staleTime ?? 0
    this.retry = options.retry ?? 0
    this.retryDelay = options.retryDelay ?? 1000
    this.events = options.events ?? {}
    this.data = signal<T | undefined>(options.initialData)
    if (options.initialData !== undefined) {
      this.status = signal<AsyncStatus>('success')
      this.scheduleStaleness()
      this.isStale.set(this.staleTime === 0)
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

  finalizeSnapshot(snapshot: Snapshot): void {
    const id = snapshotIds.get(snapshot)
    if (id === undefined) return
    const record = this.snapshots.find((s) => s.live && s.id === id)
    if (!record) return
    record.live = false
    this.snapshots = this.snapshots.filter((s) => s !== record)
    if (!this.snapshots.some((s) => s.live)) {
      this.hasPendingMutations.set(false)
    }
  }

  firstValue(): Promise<T> {
    if (this.status.peek() === 'success') {
      return Promise.resolve(this.data.peek() as T)
    }
    if (this.status.peek() === 'error') {
      return Promise.reject(this.error.peek())
    }
    return new Promise<T>((resolve, reject) => {
      const unsub = this.status.subscribe((s) => {
        if (s === 'success') {
          unsub()
          resolve(this.data.peek() as T)
        } else if (s === 'error') {
          unsub()
          reject(this.error.peek())
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
  }
}

const snapshotIds = new WeakMap<Snapshot, number>()

export function tagSnapshot(snapshot: Snapshot, id: number): Snapshot {
  snapshotIds.set(snapshot, id)
  return snapshot
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
