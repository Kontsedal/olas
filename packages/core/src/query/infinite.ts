import { type Signal, batch, computed, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import { isAbortError } from '../utils'
import type { AsyncState, AsyncStatus, RetryDelay, RetryPolicy } from './types'

/**
 * Configuration for `defineInfiniteQuery({ ... })`. Spec §5.7, §20.4.
 *
 * - `getNextPageParam(lastPage, allPages)` returns the param for the next
 *   page, or `null` when there's no more.
 * - `getPreviousPageParam` (optional) enables bidirectional infinite lists.
 * - `itemsOf(page)` (optional) flattens pages into items for the
 *   `subscription.flat` convenience signal.
 */
export type InfiniteQuerySpec<Args extends unknown[], PageParam, TPage, TItem = TPage> = {
  key: (...args: Args) => unknown[]
  fetcher: (pageCtx: { pageParam: PageParam; signal: AbortSignal }, ...args: Args) => Promise<TPage>
  initialPageParam: PageParam
  getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
  getPreviousPageParam?: (firstPage: TPage, allPages: TPage[]) => PageParam | null
  itemsOf?: (page: TPage) => TItem[]
  staleTime?: number
  gcTime?: number
  refetchInterval?: number
  keepPreviousData?: boolean
  retry?: RetryPolicy
  retryDelay?: RetryDelay
}

/**
 * Module-scoped handle for a paginated query. Mirrors `Query<Args, TPage[]>`
 * with paginated `setData` semantics.
 */
export type InfiniteQuery<Args extends unknown[], TPage, TItem> = {
  readonly __olas: 'infiniteQuery'
  invalidate(...args: Args): void
  invalidateAll(): void
  setData(...args: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): {
    rollback: () => void
  }
  prefetch(...args: Args): Promise<TPage>
}

/**
 * What `ctx.use(infiniteQuery, ...)` returns. Extends `AsyncState<TPage[]>`
 * with paginated controls: `fetchNextPage` / `fetchPreviousPage`,
 * `hasNextPage` / `hasPreviousPage`, and per-direction `isFetching` signals.
 *
 * `flat` is a convenience: present when the query spec provides `itemsOf` —
 * otherwise it's an empty array.
 */
export type InfiniteQuerySubscription<TPage, TItem> = AsyncState<TPage[]> & {
  pages: ReadSignal<TPage[]>
  flat: ReadSignal<TItem[]>
  hasNextPage: ReadSignal<boolean>
  hasPreviousPage: ReadSignal<boolean>
  isFetchingNextPage: ReadSignal<boolean>
  isFetchingPreviousPage: ReadSignal<boolean>
  fetchNextPage: () => Promise<void>
  fetchPreviousPage: () => Promise<void>
}

type Snapshot = { rollback: () => void }

/**
 * Holds an array of pages plus their pageParams. Supports fetchNextPage /
 * fetchPreviousPage / invalidate (drops all pages). Race-protected.
 *
 * Internal.
 */
export class InfiniteEntry<TPage, TItem, PageParam> {
  readonly pages: Signal<TPage[]> = signal<TPage[]>([])
  readonly pageParams: Signal<PageParam[]>
  readonly data: ReadSignal<TPage[] | undefined>
  readonly error: Signal<unknown | undefined> = signal(undefined)
  readonly status: Signal<AsyncStatus> = signal<AsyncStatus>('idle')
  readonly isLoading: Signal<boolean> = signal(false)
  readonly isFetching: Signal<boolean> = signal(false)
  readonly isStale: Signal<boolean> = signal(true)
  readonly lastUpdatedAt: Signal<number | undefined> = signal(undefined)
  readonly hasPendingMutations: Signal<boolean> = signal(false)

  readonly isFetchingNextPage: Signal<boolean> = signal(false)
  readonly isFetchingPreviousPage: Signal<boolean> = signal(false)

  readonly hasNextPage: ReadSignal<boolean>
  readonly hasPreviousPage: ReadSignal<boolean>
  readonly flat: ReadSignal<TItem[]>

  private currentFetchId = 0
  private currentAbort: AbortController | null = null
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private snapshots: Array<{ id: number; prev: TPage[]; live: boolean }> = []
  private nextSnapshotId = 0
  private disposed = false

  private readonly fetcher: (pageCtx: {
    pageParam: PageParam
    signal: AbortSignal
  }) => Promise<TPage>
  private readonly initialPageParam: PageParam
  private readonly getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
  private readonly getPreviousPageParam:
    | ((firstPage: TPage, allPages: TPage[]) => PageParam | null)
    | undefined
  private readonly staleTime: number
  private readonly retry: RetryPolicy
  private readonly retryDelay: RetryDelay
  private readonly itemsOf?: (page: TPage) => TItem[]

  constructor(opts: {
    fetcher: (pageCtx: { pageParam: PageParam; signal: AbortSignal }) => Promise<TPage>
    initialPageParam: PageParam
    getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
    getPreviousPageParam?: (firstPage: TPage, allPages: TPage[]) => PageParam | null
    itemsOf?: (page: TPage) => TItem[]
    staleTime?: number
    retry?: RetryPolicy
    retryDelay?: RetryDelay
  }) {
    this.fetcher = opts.fetcher
    this.initialPageParam = opts.initialPageParam
    this.getNextPageParam = opts.getNextPageParam
    this.getPreviousPageParam = opts.getPreviousPageParam
    this.itemsOf = opts.itemsOf
    this.staleTime = opts.staleTime ?? 0
    this.retry = opts.retry ?? 0
    this.retryDelay = opts.retryDelay ?? 1000
    this.pageParams = signal<PageParam[]>([])
    this.data = computed(() => {
      const ps = this.pages.value
      return ps.length === 0 ? undefined : ps
    })
    this.flat = computed<TItem[]>(() => {
      const ps = this.pages.value
      if (!this.itemsOf) return ps as unknown as TItem[]
      const out: TItem[] = []
      for (const p of ps) {
        for (const item of this.itemsOf(p)) out.push(item)
      }
      return out
    })
    this.hasNextPage = computed(() => {
      const ps = this.pages.value
      if (ps.length === 0) return false
      return this.getNextPageParam(ps[ps.length - 1] as TPage, ps) !== null
    })
    this.hasPreviousPage = computed(() => {
      const ps = this.pages.value
      if (ps.length === 0) return false
      const fn = this.getPreviousPageParam
      if (!fn) return false
      return fn(ps[0] as TPage, ps) !== null
    })
  }

  /** Initial / refetch — drops all pages and fetches starting from initialPageParam. */
  startFetch(): Promise<TPage> {
    if (this.disposed) return Promise.reject(new Error('Entry disposed'))
    const myId = ++this.currentFetchId
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort

    const previouslyHadPages = this.pages.peek().length > 0
    batch(() => {
      this.status.set('pending')
      this.isFetching.set(true)
      this.isLoading.set(!previouslyHadPages)
    })

    return this.runFetch(
      myId,
      abort.signal,
      this.initialPageParam,
      (page, param) => {
        if (myId !== this.currentFetchId || this.disposed) return
        batch(() => {
          this.pages.set([page])
          this.pageParams.set([param])
          this.error.set(undefined)
          this.status.set('success')
          this.isLoading.set(false)
          this.isFetching.set(false)
          this.lastUpdatedAt.set(Date.now())
          this.isStale.set(this.staleTime === 0)
        })
        if (this.staleTime > 0) this.scheduleStaleness()
      },
      'initial',
    )
  }

  fetchNextPage(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Entry disposed'))
    if (this.isFetchingNextPage.peek()) return Promise.resolve()
    const ps = this.pages.peek()
    if (ps.length === 0) {
      return this.startFetch().then(() => {})
    }
    const nextParam = this.getNextPageParam(ps[ps.length - 1] as TPage, ps)
    if (nextParam === null) return Promise.resolve()

    const myId = ++this.currentFetchId
    const abort = new AbortController()
    this.currentAbort?.abort()
    this.currentAbort = abort
    batch(() => {
      this.isFetchingNextPage.set(true)
      this.isFetching.set(true)
    })

    return this.runFetch(
      myId,
      abort.signal,
      nextParam,
      (page, param) => {
        if (myId !== this.currentFetchId || this.disposed) return
        batch(() => {
          this.pages.set([...this.pages.peek(), page])
          this.pageParams.set([...this.pageParams.peek(), param])
          this.isFetchingNextPage.set(false)
          this.isFetching.set(false)
          this.lastUpdatedAt.set(Date.now())
        })
      },
      'next',
    ).then(() => {})
  }

  fetchPreviousPage(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Entry disposed'))
    if (this.isFetchingPreviousPage.peek()) return Promise.resolve()
    if (!this.getPreviousPageParam) return Promise.resolve()
    const ps = this.pages.peek()
    if (ps.length === 0) {
      return this.startFetch().then(() => {})
    }
    const prevParam = this.getPreviousPageParam(ps[0] as TPage, ps)
    if (prevParam === null) return Promise.resolve()

    const myId = ++this.currentFetchId
    const abort = new AbortController()
    this.currentAbort?.abort()
    this.currentAbort = abort
    batch(() => {
      this.isFetchingPreviousPage.set(true)
      this.isFetching.set(true)
    })

    return this.runFetch(
      myId,
      abort.signal,
      prevParam,
      (page, param) => {
        if (myId !== this.currentFetchId || this.disposed) return
        batch(() => {
          this.pages.set([page, ...this.pages.peek()])
          this.pageParams.set([param, ...this.pageParams.peek()])
          this.isFetchingPreviousPage.set(false)
          this.isFetching.set(false)
          this.lastUpdatedAt.set(Date.now())
        })
      },
      'prev',
    ).then(() => {})
  }

  private async runFetch(
    myId: number,
    signal: AbortSignal,
    pageParam: PageParam,
    onSuccess: (page: TPage, param: PageParam) => void,
    direction: 'initial' | 'next' | 'prev',
  ): Promise<TPage> {
    let attempt = 0
    while (true) {
      if (myId !== this.currentFetchId || this.disposed) {
        throw new DOMException('Superseded', 'AbortError')
      }
      try {
        const page = await this.fetcher({ pageParam, signal })
        if (myId !== this.currentFetchId || this.disposed) {
          throw new DOMException('Superseded', 'AbortError')
        }
        onSuccess(page, pageParam)
        return page
      } catch (err) {
        if (myId !== this.currentFetchId || this.disposed || isAbortError(err)) {
          throw err
        }
        const shouldRetry =
          typeof this.retry === 'number' ? attempt < this.retry : this.retry(attempt, err)
        if (!shouldRetry) {
          batch(() => {
            this.error.set(err)
            this.status.set('error')
            this.isLoading.set(false)
            this.isFetching.set(false)
            if (direction === 'next') this.isFetchingNextPage.set(false)
            if (direction === 'prev') this.isFetchingPreviousPage.set(false)
          })
          throw err
        }
        const delay =
          typeof this.retryDelay === 'function' ? this.retryDelay(attempt) : this.retryDelay
        await abortableSleep(delay, signal)
        attempt += 1
      }
    }
  }

  refetch(): Promise<TPage> {
    return this.startFetch()
  }

  invalidate(): Promise<TPage> {
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
      this.status.set(this.pages.peek().length > 0 ? 'success' : 'idle')
    })
  }

  setData(updater: (prev: TPage[] | undefined) => TPage[]): Snapshot {
    if (this.disposed) {
      return { rollback: () => {} }
    }
    const prev = this.pages.peek()
    const next = updater(prev.length === 0 ? undefined : prev)
    const id = this.nextSnapshotId++
    const record = { id, prev, live: true }
    this.snapshots.push(record)

    batch(() => {
      this.pages.set(next)
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
          this.pages.set(record.prev)
          this.snapshots = this.snapshots.filter((s) => s.id !== id)
          this.hasPendingMutations.set(this.snapshots.some((s) => s.live))
        })
      },
    }
  }

  firstValue(): Promise<TPage[]> {
    if (this.status.peek() === 'success') {
      return Promise.resolve(this.pages.peek())
    }
    if (this.status.peek() === 'error') {
      return Promise.reject(this.error.peek())
    }
    return new Promise<TPage[]>((resolve, reject) => {
      const unsub = this.status.subscribe((s) => {
        if (s === 'success') {
          unsub()
          resolve(this.pages.peek())
        } else if (s === 'error') {
          unsub()
          reject(this.error.peek())
        }
      })
    })
  }

  isStaleNow(): boolean {
    const last = this.lastUpdatedAt.peek()
    if (last === undefined) return true
    return Date.now() - last >= this.staleTime
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
