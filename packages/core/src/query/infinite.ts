import { batch, computed, type Signal, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import { abortableSleep, isAbortError } from '../utils'
import { subscribeReconnect } from './focus-online'
import { structuralShare } from './structural-share'
import type {
  AsyncState,
  AsyncStatus,
  NetworkMode,
  RetryDelay,
  RetryPolicy,
  Snapshot,
} from './types'

/**
 * Configuration for `defineInfiniteQuery({ ... })`. Spec §5.7, §20.4.
 *
 * - `getNextPageParam(lastPage, allPages)` returns the param for the next
 *   page, or `null` when there's no more.
 * - `getPreviousPageParam` (optional) enables bidirectional infinite lists.
 * - `itemsOf(page)` (optional) flattens pages into items for the
 *   `subscription.flat` convenience signal.
 */
export type InfiniteFetchCtx<PageParam> = {
  pageParam: PageParam
  signal: AbortSignal
  deps: import('../controller/types').AmbientDeps
}

export type InfiniteQuerySpec<Args extends unknown[], PageParam, TPage, TItem = TPage> = {
  key: (...args: Args) => unknown[]
  /**
   * Fetcher receives an `InfiniteFetchCtx` (pageParam + signal + deps) as
   * the first arg and positional cache args after. See `FetchCtx` for the
   * regular-query analogue.
   */
  fetcher: (ctx: InfiniteFetchCtx<PageParam>, ...args: Args) => Promise<TPage>
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
  /** See `QuerySpec.networkMode`. Defaults to `'online'`. */
  networkMode?: NetworkMode
  /**
   * Stable identifier used by `QueryClientPlugin`s (`@kontsedal/olas-cross-tab`,
   * etc.). Infinite queries do NOT propagate cross-tab in v1 — the
   * page-array payload is too heavy to be a safe default — but the field is
   * accepted for forward compatibility. SPEC §13.2.
   */
  queryId?: string
  /**
   * Opt into cross-tab sync. No effect for infinite queries in v1 (see
   * `queryId` doc above).
   */
  crossTab?: boolean
}

/**
 * Module-scoped handle for a paginated query. Mirrors `Query<Args, TPage[]>`
 * with paginated `setData` semantics.
 */
export type InfiniteQuery<Args extends unknown[], TPage, _TItem> = {
  readonly __olas: 'infiniteQuery'
  invalidate(...args: Args): void
  invalidateAll(): void
  setData(...args: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): Snapshot
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
  private snapshots: Array<{
    id: number
    prev: TPage[]
    prevParams: PageParam[]
    live: boolean
  }> = []
  private nextSnapshotId = 0
  private disposed = false
  /** Mirrors `Entry.pendingFirstValueRejects` — see that field for context. */
  private pendingFirstValueRejects: Array<(err: unknown) => void> = []

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
  private readonly networkMode: NetworkMode
  private reconnectUnsub: (() => void) | null = null
  private deferredResolvers: Array<{
    direction: 'initial' | 'next' | 'prev'
    resolve: () => void
    reject: (err: unknown) => void
  }> = []
  private readonly itemsOf?: (page: TPage) => TItem[]
  /**
   * Mirrors `Entry.onSuccessData`. Fires from `applyFetchSuccess`-equivalent
   * branches AFTER `pages.set(...)` settles. Used by `InfiniteClientEntry`
   * to emit `SetDataEvent { kind: 'infinite', source: 'fetch' }` for
   * `QueryClientPlugin`s (e.g. entity normalization).
   */
  private readonly onSuccessData?: (pages: TPage[]) => void

  constructor(opts: {
    fetcher: (pageCtx: { pageParam: PageParam; signal: AbortSignal }) => Promise<TPage>
    initialPageParam: PageParam
    getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
    getPreviousPageParam?: (firstPage: TPage, allPages: TPage[]) => PageParam | null
    itemsOf?: (page: TPage) => TItem[]
    staleTime?: number
    retry?: RetryPolicy
    retryDelay?: RetryDelay
    networkMode?: NetworkMode
    onSuccessData?: (pages: TPage[]) => void
  }) {
    this.fetcher = opts.fetcher
    this.initialPageParam = opts.initialPageParam
    this.getNextPageParam = opts.getNextPageParam
    this.getPreviousPageParam = opts.getPreviousPageParam
    this.itemsOf = opts.itemsOf
    this.staleTime = opts.staleTime ?? 0
    this.retry = opts.retry ?? 0
    this.retryDelay = opts.retryDelay ?? 1000
    this.networkMode = opts.networkMode ?? 'online'
    this.onSuccessData = opts.onSuccessData
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
    if (this.networkMode === 'online' && this.isOffline()) {
      return this.scheduleDeferredFetch('initial') as Promise<TPage>
    }
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
        // Structurally share with the previous first-page on refresh, so
        // unchanged pages keep their refs. We only share the head page —
        // initial fetch wipes the rest of the array by definition.
        const prevPages = this.pages.peek()
        const sharedPage =
          prevPages.length > 0 ? structuralShare(prevPages[0] as TPage, page) : page
        batch(() => {
          this.pages.set([sharedPage])
          this.pageParams.set([param])
          this.error.set(undefined)
          this.status.set('success')
          this.isLoading.set(false)
          this.isFetching.set(false)
          this.lastUpdatedAt.set(Date.now())
          this.isStale.set(this.staleTime === 0)
        })
        if (this.staleTime > 0) this.scheduleStaleness()
        this.onSuccessData?.(this.pages.peek())
      },
      'initial',
    )
  }

  fetchNextPage(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Entry disposed'))
    if (this.isFetchingNextPage.peek()) return Promise.resolve()
    if (this.networkMode === 'online' && this.isOffline()) {
      return this.scheduleDeferredFetch('next') as Promise<void>
    }
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
        this.onSuccessData?.(this.pages.peek())
      },
      'next',
    ).then(() => {})
  }

  fetchPreviousPage(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Entry disposed'))
    if (this.isFetchingPreviousPage.peek()) return Promise.resolve()
    if (!this.getPreviousPageParam) return Promise.resolve()
    if (this.networkMode === 'online' && this.isOffline()) {
      return this.scheduleDeferredFetch('prev') as Promise<void>
    }
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
        this.onSuccessData?.(this.pages.peek())
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
    let succeeded = false
    try {
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
          succeeded = true
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
    } finally {
      // Catch-all reset for the supersede/abort path. The success and explicit
      // failure paths already reset these via `onSuccess` and the
      // `applyFailure`-equivalent branch above; this guarantees that an
      // aborted-mid-flight `fetchNextPage` (e.g., user calls `invalidate()`
      // while paging) doesn't wedge the spinner.
      if (!succeeded) {
        batch(() => {
          if (direction === 'next') this.isFetchingNextPage.set(false)
          if (direction === 'prev') this.isFetchingPreviousPage.set(false)
        })
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
      return { rollback: () => {}, finalize: () => {} }
    }
    const prev = this.pages.peek()
    const prevParams = this.pageParams.peek()
    const next = updater(prev.length === 0 ? undefined : prev)
    const id = this.nextSnapshotId++
    // Snapshot BOTH pages and pageParams so rollback restores a consistent
    // pair. Without `prevParams`, an optimistic insert would shift `pages`
    // permanently out of sync with `pageParams` on rollback — and any
    // subsequent `fetchNextPage`/`getNextPageParam` would operate on the
    // wrong head.
    const record = { id, prev, prevParams, live: true }
    this.snapshots.push(record)

    // If the updater changed the page count, trim or pad pageParams so the
    // two arrays stay length-aligned. Padding uses the last known param,
    // which is the safest neutral choice — the caller of `setData` should
    // re-key via a real fetch (or use a future param-aware overload) if
    // the new page needs a fresh param.
    let nextParams: PageParam[] = prevParams
    if (next.length !== prevParams.length) {
      if (next.length < prevParams.length) {
        nextParams = prevParams.slice(0, next.length)
      } else {
        const pad = prevParams[prevParams.length - 1]
        nextParams = prevParams.slice()
        for (let i = prevParams.length; i < next.length; i++) {
          nextParams.push(pad as PageParam)
        }
      }
    }

    batch(() => {
      this.pages.set(next)
      if (nextParams !== prevParams) this.pageParams.set(nextParams)
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
          this.pageParams.set(record.prevParams)
          this.snapshots = this.snapshots.filter((s) => s.id !== id)
          this.hasPendingMutations.set(this.snapshots.some((s) => s.live))
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

  firstValue(): Promise<TPage[]> {
    if (this.disposed) {
      return Promise.reject(new DOMException('Entry disposed', 'AbortError'))
    }
    if (this.status.peek() === 'success') {
      return Promise.resolve(this.pages.peek())
    }
    if (this.status.peek() === 'error') {
      return Promise.reject(this.error.peek())
    }
    return new Promise<TPage[]>((resolve, reject) => {
      const tracked = (err: unknown): void => {
        this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
        reject(err)
      }
      this.pendingFirstValueRejects.push(tracked)
      const unsub = this.status.subscribe((s) => {
        if (s === 'success') {
          unsub()
          this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
          resolve(this.pages.peek())
        } else if (s === 'error') {
          unsub()
          tracked(this.error.peek())
        }
      })
    })
  }

  isStaleNow(): boolean {
    const last = this.lastUpdatedAt.peek()
    if (last === undefined) return true
    return Date.now() - last >= this.staleTime
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  }

  private scheduleDeferredFetch(direction: 'initial' | 'next' | 'prev'): Promise<unknown> {
    if (this.reconnectUnsub === null) {
      this.reconnectUnsub = subscribeReconnect(() => this.drainDeferred())
    }
    return new Promise<void>((resolve, reject) => {
      this.deferredResolvers.push({ direction, resolve, reject })
    })
  }

  private drainDeferred(): void {
    if (this.deferredResolvers.length === 0) return
    if (this.disposed) return
    const pending = this.deferredResolvers
    this.deferredResolvers = []
    if (this.reconnectUnsub !== null) {
      this.reconnectUnsub()
      this.reconnectUnsub = null
    }
    // Collapse multiple deferrals of the same direction into one real fetch.
    // Order matters: initial first (it may produce data the others need),
    // then prev / next.
    const seen = new Set<'initial' | 'next' | 'prev'>()
    const order: Array<'initial' | 'next' | 'prev'> = ['initial', 'prev', 'next']
    for (const d of pending) {
      seen.add(d.direction)
    }
    const run = async () => {
      for (const dir of order) {
        if (!seen.has(dir)) continue
        if (dir === 'initial') await this.startFetch()
        else if (dir === 'next') await this.fetchNextPage()
        else await this.fetchPreviousPage()
      }
    }
    run().then(
      () => {
        for (const p of pending) p.resolve()
      },
      (err) => {
        for (const p of pending) p.reject(err)
      },
    )
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
