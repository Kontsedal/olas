import type { BRAND } from '../brand'
import { scheduleExpiry } from '../expiry-timer'
import { batch, computed, type Signal, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import { abortableSleep, isAbortError } from '../utils'
import {
  type EntryEvents,
  type FetchFailure,
  failureContext,
  followRedirects,
  nextFetchCauseId,
  notInFuture,
} from './entry'
import { subscribeReconnect } from './focus-online'
import { structuralShare } from './structural-share'
import type {
  AsyncState,
  AsyncStatus,
  NetworkMode,
  QueryMeta,
  RefetchInterval,
  RetryDelay,
  RetryPolicy,
  Snapshot,
} from './types'

/**
 * Per-fetch context for an infinite query: the page to fetch, the
 * `AbortSignal` to honor, and the root's `deps`. See `FetchCtx` for the
 * regular-query analogue.
 */
export type InfiniteFetchCtx<PageParam> = {
  pageParam: PageParam
  signal: AbortSignal
  deps: import('../controller/types').AmbientDeps
}

/**
 * Configuration for `defineInfiniteQuery({ ... })`. Spec §5.11, §20.4.
 *
 * - `getNextPageParam(lastPage, allPages)` returns the param for the next
 *   page, or `null` when there's no more.
 * - `getPreviousPageParam` (optional) enables bidirectional infinite lists.
 * - `itemsOf(page)` (optional) flattens pages into items for the
 *   `subscription.flat` convenience signal.
 */
export type InfiniteQuerySpec<Args extends unknown[], PageParam, TPage, TItem = TPage> = {
  /**
   * See `QuerySpec.id`. Required, and unique across regular and infinite queries.
   */
  id: string
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
  /**
   * Fixed gap in ms, or a thunk resolved once per tick over the entry's
   * latest **pages array** (`undefined` until the first page lands) — see
   * `RefetchInterval` for the contract. A tick re-fetches every loaded page
   * (see "Refetch semantics", spec §5.11), so pick gaps accordingly.
   */
  refetchInterval?: RefetchInterval<TPage[]>
  keepPreviousData?: boolean
  retry?: RetryPolicy
  retryDelay?: RetryDelay
  /**
   * See `QuerySpec.refetchOnWindowFocus`. A focus refetch re-fetches every loaded page.
   */
  refetchOnWindowFocus?: boolean
  /**
   * See `QuerySpec.refetchOnReconnect`. A reconnect refetch re-fetches every loaded page.
   */
  refetchOnReconnect?: boolean
  /**
   * See `QuerySpec.networkMode`. Defaults to `'online'`.
   */
  networkMode?: NetworkMode
  /**
   * See `QuerySpec.structuralShare`. Applies to the head-page refresh.
   */
  structuralShare?: boolean
  /**
   * See `QuerySpec.meta`.
   */
  meta?: QueryMeta
}

/**
 * Module-scoped handle for a paginated query. Mirrors `Query<Args, TPage[]>`
 * with paginated `setData` semantics.
 */
export type InfiniteQuery<Args extends unknown[], TPage, _TItem> = {
  readonly [BRAND]: 'infiniteQuery'
  /**
   * Like `Query.invalidate`; resolves when the triggered refetch (all loaded pages) settles.
   */
  invalidate(...args: Args): Promise<void>
  /**
   * Like `Query.invalidateAll`; resolves when every entry's refetch settles.
   */
  invalidateAll(): Promise<void>
  setData(...args: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): Snapshot
  /**
   * Like `Query.write`: a canonical patch of the loaded pages. No snapshot,
   * no `hasPendingMutations`, and a fetch already in flight is left alone.
   * If the updater changes the page count, `pageParams` is trimmed or padded
   * with the last param to stay aligned, as with `setData`.
   */
  write(...args: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): void
  /**
   * Like `Query.replace`: the pages ARE the record now, so a fetch already in
   * flight for the key is cancelled. `pageParams` is aligned as with `write`;
   * refetch when the new pages need fresh params.
   */
  replace(...args: [...Args, pages: TPage[]]): void
  /**
   * Like `Query.peek`: the loaded pages, read without creating an entry or
   * subscribing. `undefined` when no entry exists or no page has loaded.
   */
  peek(...args: Args): TPage[] | undefined
  /** Cancel the in-flight fetch (initial/refetch or paging) for a key. See
   *  `Query.cancel` (spec §5, §6.4). */
  cancel(...args: Args): void
  /**
   * Cancel in-flight fetches for every keyed entry of this infinite query.
   */
  cancelAll(): void
  /**
   * Like `Query.prefetch`, resolving with the first page. A request already in
   * flight is joined, not restarted.
   */
  prefetch(...args: Args): Promise<TPage>
}

/** Imperative paginated-query operations bound to one root. */
export type InfiniteQueryActions<Args extends unknown[], TPage, TItem> = Omit<
  InfiniteQuery<Args, TPage, TItem>,
  typeof BRAND
>

/**
 * What `createQuery(ctx, infiniteQuery, ...)` returns. Extends `AsyncState<TPage[]>`
 * with paginated controls: `fetchNextPage` / `fetchPreviousPage`,
 * `hasNextPage` / `hasPreviousPage`, and per-direction `isFetching` signals.
 *
 * `flat` is a convenience: the pages' items, flattened through the spec's
 * `itemsOf`. Without `itemsOf`, `flat` equals `pages` (spec §5.11).
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
 * fetchPreviousPage / invalidate (re-fetches every loaded page). Race-protected.
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
  /** True while a fetch is parked waiting for reconnect: an `online`-mode
   *  fetch requested while offline, or an `offlineFirst` fetch that hit a
   *  network error while offline. Spec §5.5. Mirrors `Entry.isPaused`. */
  readonly isPaused: Signal<boolean> = signal(false)

  readonly isFetchingNextPage: Signal<boolean> = signal(false)
  readonly isFetchingPreviousPage: Signal<boolean> = signal(false)

  readonly hasNextPage: ReadSignal<boolean>
  readonly hasPreviousPage: ReadSignal<boolean>
  readonly flat: ReadSignal<TItem[]>

  private currentFetchId = 0
  private currentAbort: AbortController | null = null
  /** The request in flight (refetch or page), while one is. See `Entry.currentRequest`. */
  private currentRequest: Promise<unknown> | null = null
  /** `currentFetchId` of the catch-up refetch; `0` when none has run. */
  private catchUpFetchId = 0
  /** `invalidate()` promises waiting on a refetch, by it. See `Entry.redirects`. */
  private readonly redirects = new WeakMap<Promise<unknown>, (catchUp: Promise<unknown>) => void>()
  /** The latest failed fetch, for the client's error report. */
  private lastFailure: FetchFailure | null = null
  private staleTimer: (() => void) | null = null
  /** Set by `markStale()` (invalidate without fetch). See `Entry.forcedStale`. */
  private forcedStale = false
  /** Bumped by every `markStale()`. See `Entry.staleEpoch`. */
  private staleEpoch = 0
  /** `Date.now()` of the latest `markStale()`. See `Entry.staleSince`. */
  private staleSince = 0
  /** When the server truth the pages hold was written. See `Entry.serverUpdatedAt`. */
  private serverUpdatedAt: number | undefined
  /** See `EntryOptions.hasSubscribers`. */
  private readonly hasSubscribers: () => boolean
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
    attempt: number
  }) => Promise<TPage>
  private readonly initialPageParam: PageParam
  private readonly getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
  private readonly getPreviousPageParam:
    | ((firstPage: TPage, allPages: TPage[]) => PageParam | null)
    | undefined
  private readonly staleTime: number
  private readonly retry: RetryPolicy
  private readonly retryDelay: RetryDelay | undefined
  private readonly networkMode: NetworkMode
  private readonly structuralShareEnabled: boolean
  private reconnectUnsub: (() => void) | null = null
  private deferredResolvers: Array<{
    direction: 'initial' | 'next' | 'prev'
    /** An `'initial'` waiter gets the first page, as `startFetch` resolves. */
    resolve: (value?: unknown) => void
    reject: (err: unknown) => void
  }> = []
  private readonly itemsOf?: (page: TPage) => TItem[]
  /**
   * Mirrors `Entry.onSuccessData`. Fires from every successful page batch
   * AFTER `pages.set(...)` settles, so `InfiniteClientEntry` can report a
   * `'fetch'` write to plugins (entity normalization walks the pages).
   */
  private readonly onSuccessData?: (pages: TPage[]) => void
  private readonly events: EntryEvents
  /** `causeId` and start time of the fetch in flight, for its devtools events. */
  private fetchCauseId = ''
  private fetchStartTime = 0

  constructor(opts: {
    fetcher: (pageCtx: {
      pageParam: PageParam
      signal: AbortSignal
      attempt: number
    }) => Promise<TPage>
    initialPageParam: PageParam
    getNextPageParam: (lastPage: TPage, allPages: TPage[]) => PageParam | null
    getPreviousPageParam?: (firstPage: TPage, allPages: TPage[]) => PageParam | null
    itemsOf?: (page: TPage) => TItem[]
    staleTime?: number
    retry?: RetryPolicy
    retryDelay?: RetryDelay
    networkMode?: NetworkMode
    structuralShare?: boolean
    onSuccessData?: (pages: TPage[]) => void
    events?: EntryEvents
    /** See `EntryOptions.hasSubscribers`. */
    hasSubscribers?: () => boolean
    /**
     * Seeds the entry from a hydrated payload: pages with their params, aligned.
     */
    initialPages?: TPage[]
    initialPageParams?: PageParam[]
    initialUpdatedAt?: number
  }) {
    this.fetcher = opts.fetcher
    this.initialPageParam = opts.initialPageParam
    this.getNextPageParam = opts.getNextPageParam
    this.getPreviousPageParam = opts.getPreviousPageParam
    this.itemsOf = opts.itemsOf
    this.staleTime = opts.staleTime ?? 0
    this.retry = opts.retry ?? 0
    this.retryDelay = opts.retryDelay
    this.networkMode = opts.networkMode ?? 'online'
    this.structuralShareEnabled = opts.structuralShare ?? true
    this.onSuccessData = opts.onSuccessData
    this.events = opts.events ?? {}
    this.hasSubscribers = opts.hasSubscribers ?? (() => false)
    this.pageParams = signal<PageParam[]>([])
    const seeded = opts.initialPages
    if (seeded !== undefined && seeded.length > 0) {
      const seededAt = notInFuture(opts.initialUpdatedAt)
      this.pages.set(seeded)
      this.pageParams.set(opts.initialPageParams ?? [])
      this.status.set('success')
      this.lastUpdatedAt.set(seededAt)
      this.serverUpdatedAt = seededAt
      this.settleStaleness(seededAt)
    }
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

  /**
   * Initial load / refetch. On the initial load (no pages yet) this fetches
   * the first page. On a refetch of an already-loaded entry (interval,
   * invalidate, focus/reconnect) it **refetches every currently-loaded page**
   * sequentially, re-deriving each page's param from the freshly-fetched data
   * via `getNextPageParam` — matching TanStack and avoiding the old
   * "collapse to page one" truncation that dropped every loaded page but the
   * first on each refetch (T3.7). Pages/params update atomically at the end,
   * so subscribers never observe a mid-refetch truncation flash.
   */
  startFetch(): Promise<TPage> {
    if (this.disposed) return Promise.reject(new Error('Entry disposed'))
    if (this.networkMode === 'online' && this.isOffline()) {
      // Supersede the request in flight before parking, as `Entry.startFetch`.
      let parked: Promise<unknown> | undefined
      batch(() => {
        this.cancel()
        parked = this.scheduleDeferredFetch('initial')
      })
      return parked as Promise<TPage>
    }
    const myId = ++this.currentFetchId
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort

    const previousPages = this.pages.peek()
    batch(() => {
      this.status.set('pending')
      this.isFetching.set(true)
      this.isLoading.set(previousPages.length === 0)
      this.isPaused.set(false)
      // The paging flags follow the request that owns the entry: a refetch
      // supersedes any page request in flight.
      this.isFetchingNextPage.set(false)
      this.isFetchingPreviousPage.set(false)
    })
    this.announceFetchStart()

    return this.releaseOnSettle(
      this.runRefetchAll(
        myId,
        abort.signal,
        Math.max(1, previousPages.length),
        previousPages,
        this.staleEpoch,
      ),
      abort,
    )
  }

  /**
   * Record `work` as the request in flight, and forget it and `abort` once it
   * settles. A finished request has nothing to cancel, and `abort()` on its
   * controller still builds a `DOMException`: kept as `currentAbort`, it made
   * every refetch, hydration and dispose pay for one.
   */
  private releaseOnSettle<R>(work: Promise<R>, abort: AbortController): Promise<R> {
    this.currentRequest = work
    const release = (): void => {
      if (this.currentAbort === abort) this.currentAbort = null
      if (this.currentRequest === work) this.currentRequest = null
    }
    work.then(release, release)
    return work
  }

  /**
   * Fetch `targetCount` pages from `initialPageParam`, chaining each next param
   * via `getNextPageParam` from the freshly-fetched pages. Applies the query's
   * retry policy per page. Stops early if the dataset shrank (a page yields
   * `getNextPageParam === null`). Writes pages/params in ONE batch at the end;
   * a per-page failure keeps the existing pages and surfaces the error; a
   * supersede/dispose throws `AbortError` without writing. `staleEpoch` is the
   * `staleEpoch` the refetch started under (see `Entry.applySuccess`).
   */
  private async runRefetchAll(
    myId: number,
    signal: AbortSignal,
    targetCount: number,
    previousPages: TPage[],
    staleEpoch: number,
  ): Promise<TPage> {
    const newPages: TPage[] = []
    const newParams: PageParam[] = []
    let pageParam: PageParam = this.initialPageParam
    try {
      for (let i = 0; i < targetCount; i++) {
        let attempt = 0
        while (true) {
          if (myId !== this.currentFetchId || this.disposed) {
            throw new DOMException('Superseded', 'AbortError')
          }
          try {
            const page = await this.fetcher({ pageParam, signal, attempt })
            if (myId !== this.currentFetchId || this.disposed) {
              throw new DOMException('Superseded', 'AbortError')
            }
            newPages.push(page)
            newParams.push(pageParam)
            break
          } catch (err) {
            // Superseded or disposed: the newer request owns the entry's state.
            // Its caller hears the supersede, not the stale error — see `Entry`.
            if (myId !== this.currentFetchId || this.disposed) {
              throw new DOMException('Superseded', 'AbortError')
            }
            // offlineFirst: a network-shaped failure while offline parks the
            // entry until reconnect instead of surfacing the error. The drain
            // re-runs the whole refetch, so the pages fetched so far are dropped.
            if (this.parksOnOffline(err)) {
              return (await this.park('initial')) as TPage
            }
            // Still the latest request, yet it aborted — so the fetcher aborted
            // itself (its own timeout signal, a rethrown stale abort). Every
            // engine-side abort bumps `currentFetchId` or sets `disposed` first.
            // Nothing newer is coming to settle the entry, so it settles as a
            // failure; aborts never go through the retry policy.
            let delay: number | null
            try {
              delay = this.nextRetryDelay(attempt, err)
            } catch (policyErr) {
              // A throwing `retry` / `retryDelay` fails the attempt — see `Entry`.
              this.settleFailure(policyErr, attempt, 'initial', err)
              throw policyErr
            }
            if (delay === null) {
              this.settleFailure(err, attempt, 'initial')
              throw err
            }
            await abortableSleep(delay, signal)
            attempt += 1
          }
        }
        const next = this.getNextPageParam(newPages[newPages.length - 1] as TPage, newPages)
        if (next === null) break
        pageParam = next
      }
      if (myId !== this.currentFetchId || this.disposed) {
        throw new DOMException('Superseded', 'AbortError')
      }
      // Structurally share the head page so an unchanged first page keeps its
      // ref (downstream `computed`s / React snapshots don't thrash).
      const finalPages =
        previousPages.length > 0 && this.structuralShareEnabled && newPages.length > 0
          ? [structuralShare(previousPages[0] as TPage, newPages[0] as TPage), ...newPages.slice(1)]
          : newPages
      // Rebase live optimistic snapshots onto the fresh pages, as
      // `Entry.applySuccess` does: a later rollback restores this server truth,
      // not the pre-fetch baseline the snapshot captured (spec §6.4).
      for (const s of this.snapshots) {
        s.prev = finalPages
        s.prevParams = newParams
      }
      // Pages requested after the latest `markStale()` reconcile it; an older
      // refetch leaves it in force, and a held entry catches up (§5.7, as
      // `Entry.applySuccess`).
      if (staleEpoch === this.staleEpoch) this.forcedStale = false
      const landed = this.currentRequest
      batch(() => {
        this.pages.set(finalPages)
        this.pageParams.set(newParams)
        this.error.set(undefined)
        this.status.set('success')
        this.isLoading.set(false)
        this.isFetching.set(false)
        this.markServerWrite(Date.now())
        this.isStale.set(this.forcedStale || this.staleTime === 0)
        // Before any catch-up starts, while `fetchCauseId` is still this one's.
        this.announceFetchSuccess()
        this.catchUpIfStillStale(landed)
      })
      if (this.staleTime > 0 && !this.forcedStale) this.scheduleStaleness()
      this.onSuccessData?.(this.pages.peek())
      return finalPages[0] as TPage
    } finally {
      // Status repair (T3.3): a superseded refetch must never leave the entry
      // wedged at 'pending' when data is present and nothing is fetching. The
      // superseder owns the final status; this only fires for the terminal
      // fetch of a supersede chain. Never clobbers a real 'error'.
      if (
        !this.disposed &&
        this.status.peek() === 'pending' &&
        !this.isFetching.peek() &&
        this.pages.peek().length > 0
      ) {
        this.status.set('success')
      }
    }
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
      this.isFetchingPreviousPage.set(false) // superseded, if it was in flight
      this.isFetching.set(true)
      // Pages exist, so nothing is loading for the first time, even when this
      // request supersedes a first load that a write filled in meanwhile.
      this.isLoading.set(false)
    })
    this.announceFetchStart()

    return this.releaseOnSettle(
      this.runFetch(
        myId,
        abort.signal,
        nextParam,
        (page, param) => {
          if (myId !== this.currentFetchId || this.disposed) return
          // The appended page is server truth each baseline lacks: add it, so
          // a rollback keeps it and drops only the optimistic delta (§6.4).
          for (const s of this.snapshots) {
            s.prev = [...s.prev, page]
            s.prevParams = [...s.prevParams, param]
          }
          batch(() => {
            this.pages.set([...this.pages.peek(), page])
            this.pageParams.set([...this.pageParams.peek(), param])
            this.error.set(undefined)
            // A successful page op owns the terminal status: restore 'success'
            // so paging that superseded a mid-flight full refetch (which left
            // status at 'pending') can't wedge the entry / Suspense (T3.3).
            this.status.set('success')
            this.isFetchingNextPage.set(false)
            this.isFetching.set(false)
            this.markServerWrite(Date.now())
          })
        },
        'next',
      ).then(() => {}),
      abort,
    )
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
      this.isFetchingNextPage.set(false) // superseded, if it was in flight
      this.isFetching.set(true)
      this.isLoading.set(false) // see fetchNextPage
    })
    this.announceFetchStart()

    return this.releaseOnSettle(
      this.runFetch(
        myId,
        abort.signal,
        prevParam,
        (page, param) => {
          if (myId !== this.currentFetchId || this.disposed) return
          // Prepend the page to every baseline — see `fetchNextPage`.
          for (const s of this.snapshots) {
            s.prev = [page, ...s.prev]
            s.prevParams = [param, ...s.prevParams]
          }
          batch(() => {
            this.pages.set([page, ...this.pages.peek()])
            this.pageParams.set([param, ...this.pageParams.peek()])
            this.error.set(undefined)
            // A successful page op owns the terminal status — see fetchNextPage
            // (T3.3).
            this.status.set('success')
            this.isFetchingPreviousPage.set(false)
            this.isFetching.set(false)
            this.markServerWrite(Date.now())
          })
        },
        'prev',
      ).then(() => {}),
      abort,
    )
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
          const page = await this.fetcher({ pageParam, signal, attempt })
          if (myId !== this.currentFetchId || this.disposed) {
            throw new DOMException('Superseded', 'AbortError')
          }
          batch(() => {
            onSuccess(page, pageParam)
            succeeded = true
            this.announceFetchSuccess()
            // A page never reconciles an invalidation, so a held entry that is
            // still force-stale re-fetches every page, the new one included.
            this.catchUpIfStillStale(null)
          })
          this.onSuccessData?.(this.pages.peek())
          return page
        } catch (err) {
          if (myId !== this.currentFetchId || this.disposed) {
            throw new DOMException('Superseded', 'AbortError')
          }
          // offlineFirst park — see `runRefetchAll`. The drain re-runs this
          // direction once the network is back.
          if (this.parksOnOffline(err)) {
            await this.park(direction)
            return this.pages.peek()[
              direction === 'prev' ? 0 : this.pages.peek().length - 1
            ] as TPage
          }
          // A self-inflicted abort settles as a failure — see `runRefetchAll`.
          let delay: number | null
          try {
            delay = this.nextRetryDelay(attempt, err)
          } catch (policyErr) {
            // A throwing `retry` / `retryDelay` fails the attempt — see `Entry`.
            this.settleFailure(policyErr, attempt, direction, err)
            throw policyErr
          }
          if (delay === null) {
            this.settleFailure(err, attempt, direction)
            throw err
          }
          await abortableSleep(delay, signal)
          attempt += 1
        }
      }
    } finally {
      // Catch-all reset for the supersede/abort path. The success and explicit
      // failure paths already reset these via `onSuccess` and
      // `settleFailure`; this guarantees that an
      // aborted-mid-flight `fetchNextPage` (e.g., user calls `invalidate()`
      // while paging) doesn't wedge the spinner.
      // A superseded request leaves the flags alone: its superseder set them.
      // Clearing here would hide a newer request of the same direction, and
      // `fetchNextPage` would stop deduplicating against it.
      if (!succeeded) {
        batch(() => {
          if (myId === this.currentFetchId) {
            if (direction === 'next') this.isFetchingNextPage.set(false)
            if (direction === 'prev') this.isFetchingPreviousPage.set(false)
          }
          // Status repair (T3.3): a superseded fetch must never leave the
          // entry wedged at 'pending' when data is present and nothing is
          // fetching. The superseding fetch normally owns the final status
          // (its onSuccess sets 'success'); this is the safety net for the
          // terminal fetch of a supersede chain. Only repair 'pending' — never
          // clobber a real 'error' — and only when no fetch is still running.
          if (
            !this.disposed &&
            this.status.peek() === 'pending' &&
            !this.isFetching.peek() &&
            this.pages.peek().length > 0
          ) {
            this.status.set('success')
          }
        })
      }
    }
  }

  refetch(): Promise<TPage> {
    return this.startFetch()
  }

  /** Force stale without fetching — see `Entry.markStale` (spec §5.7, T3.9). */
  markStale(): void {
    if (this.disposed) return
    if (this.staleTimer != null) {
      this.staleTimer()
      this.staleTimer = null
    }
    this.staleEpoch += 1
    this.staleSince = Date.now()
    this.forcedStale = true
    this.isStale.set(true)
  }

  /** Mark stale and refetch; follows a catch-up as `Entry.invalidate` does. */
  invalidate(): Promise<TPage> {
    this.markStale()
    return followRedirects<unknown>(this.startFetch(), this.redirects) as Promise<TPage>
  }

  /** The latest failure's `attempt` and `cause`, when `err` is that failure. */
  failureOf(err: unknown): { attempt: number; cause?: unknown } | undefined {
    return failureContext(this.lastFailure, err)
  }

  /**
   * Supersede the request in flight for a canonical whole-record write, and
   * re-fetch once when an invalidation's response was the one discarded.
   * Mirrors `Entry.supersedeByWrite`; the catch-up re-fetches every loaded page.
   */
  supersedeByWrite(): void {
    if (this.disposed || !this.isFetching.peek()) return
    if (this.currentFetchId === this.catchUpFetchId) return
    const discarded = this.currentRequest
    batch(() => {
      this.cancel()
      this.catchUpIfStillStale(discarded)
    })
  }

  /** See `Entry.catchUpIfStillStale`. The catch-up re-fetches every loaded page. */
  private catchUpIfStillStale(landed: Promise<unknown> | null): void {
    if (!this.forcedStale || !this.hasSubscribers()) return
    const request = this.startFetch()
    this.catchUpFetchId = this.currentFetchId
    request.catch(() => {})
    if (landed !== null) this.redirects.get(landed)?.(request)
  }

  /** Stamp a write of server truth: a fetch, a hydrated row or a canonical write. */
  private markServerWrite(at: number): void {
    this.lastUpdatedAt.set(at)
    this.serverUpdatedAt = at
  }

  reset(): void {
    if (this.disposed) return
    batch(() => {
      this.error.set(undefined)
      this.status.set(this.pages.peek().length > 0 ? 'success' : 'idle')
    })
  }

  /** Cancel an in-flight fetch (initial/refetch or paging) without touching
   *  pages. Supersedes + aborts the current request, then restores a settled
   *  status. No-op when idle. Mirrors `Entry.cancel` (spec §5, §6.4, T3.4). */
  cancel(): void {
    if (this.disposed || !this.isFetching.peek()) return
    this.currentFetchId += 1
    this.currentAbort?.abort()
    this.currentAbort = null
    batch(() => {
      this.isFetching.set(false)
      this.isLoading.set(false)
      this.isFetchingNextPage.set(false)
      this.isFetchingPreviousPage.set(false)
      this.status.set(this.pages.peek().length > 0 ? 'success' : 'idle')
    })
  }

  /**
   * `pageParams`, when given with the same length as the new pages, replaces
   * the params outright. Otherwise the params are trimmed or padded to stay
   * aligned with the pages.
   */
  setData(
    updater: (prev: TPage[] | undefined) => TPage[],
    opts?: { track?: boolean; pageParams?: readonly PageParam[] },
  ): Snapshot {
    if (this.disposed) {
      return { rollback: () => {}, finalize: () => {} }
    }
    const prev = this.pages.peek()
    const prevParams = this.pageParams.peek()
    const next = updater(prev.length === 0 ? undefined : prev)
    // `track: false` is a canonical cache write (plugin/remote/entities
    // backprop) — no optimistic snapshot, no `hasPendingMutations` flip. See
    // `Entry.setData` for the full rationale. Default `true` keeps the
    // optimistic-update path (`query.setData` in `onMutate`).
    const track = opts?.track ?? true
    // Snapshot BOTH pages and pageParams so rollback restores a consistent
    // pair. Without `prevParams`, an optimistic insert would shift `pages`
    // permanently out of sync with `pageParams` on rollback — and any
    // subsequent `fetchNextPage`/`getNextPageParam` would operate on the
    // wrong head.
    const record = track ? { id: this.nextSnapshotId++, prev, prevParams, live: true } : null
    if (record) {
      this.snapshots.push(record)
      this.announce(() => this.events.onSnapshotPush?.())
    }

    // If the updater changed the page count, trim or pad pageParams so the
    // two arrays stay length-aligned. Padding uses the last known param,
    // which is the safest neutral choice — the caller of `setData` should
    // re-key via a real fetch (or use a future param-aware overload) if
    // the new page needs a fresh param.
    let nextParams: PageParam[] = prevParams
    const given = opts?.pageParams
    if (given !== undefined && given.length === next.length) {
      nextParams = [...given]
    } else if (next.length !== prevParams.length) {
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

    // A canonical write rebases live optimistic snapshots onto itself, as
    // `Entry.setData` does: a later rollback must restore these pages, not a
    // baseline from before they arrived (spec §6.4).
    if (!track) {
      for (const sn of this.snapshots) {
        sn.prev = next
        sn.prevParams = nextParams
      }
    }
    batch(() => {
      this.pages.set(next)
      if (nextParams !== prevParams) this.pageParams.set(nextParams)
      if (this.status.peek() === 'idle' || this.status.peek() === 'pending') {
        this.status.set('success')
      }
      // A canonical write is server truth; an optimistic one is a guess.
      if (record) this.lastUpdatedAt.set(Date.now())
      else this.markServerWrite(Date.now())
      if (record) this.hasPendingMutations.set(true)
    })

    if (!record) {
      return { rollback: () => {}, finalize: () => {} }
    }
    const id = record.id
    return {
      rollback: () => {
        if (!record.live || this.disposed) return
        record.live = false
        batch(() => {
          const i = this.snapshots.indexOf(record)
          if (i !== -1) {
            if (i === this.snapshots.length - 1) {
              // Top of the stack: restore this layer's captured baseline pair
              // (pages + params stay length-aligned — see the snapshot note).
              this.pages.set(record.prev)
              this.pageParams.set(record.prevParams)
            } else {
              // Not the top: leave current pages/params alone and thread this
              // layer's baseline down onto the next layer, so a later
              // top-rollback lands on the correct pre-everything pages instead
              // of resurrecting this layer's delta (chain-splice — T3.1, spec
              // §6.4). Mirrors `Entry.setData`.
              const below = this.snapshots[i + 1] as (typeof this.snapshots)[number]
              below.prev = record.prev
              below.prevParams = record.prevParams
            }
            this.snapshots.splice(i, 1)
          }
          this.hasPendingMutations.set(this.snapshots.some((s) => s.live))
        })
        this.announce(() => this.events.onSnapshotRollback?.())
      },
      finalize: () => {
        if (!record.live || this.disposed) return
        record.live = false
        this.snapshots = this.snapshots.filter((s) => s.id !== id)
        if (!this.snapshots.some((s) => s.live)) {
          this.hasPendingMutations.set(false)
        }
        this.announce(() => this.events.onSnapshotFinalize?.())
      },
    }
  }

  /** Resolves at once when a page is loaded. Mirrors `Entry.firstValue`. */
  firstValue(): Promise<TPage[]> {
    if (this.disposed) {
      return Promise.reject(new DOMException('Entry disposed', 'AbortError'))
    }
    if (this.pages.peek().length > 0 || this.status.peek() === 'success') {
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

  /**
   * Settle with the request in flight, or with whatever takes it over: the
   * pages at `success`, the error at `error`, an `AbortError` when a `cancel()`
   * leaves no pages. Mirrors `Entry.settled`; backs `prefetchInfinite`.
   */
  settled(): Promise<TPage[]> {
    if (this.disposed) {
      return Promise.reject(new DOMException('Entry disposed', 'AbortError'))
    }
    const now = this.settledOutcome()
    if (now !== null) return now
    return new Promise<TPage[]>((resolve, reject) => {
      const tracked = (err: unknown): void => {
        stop()
        reject(err)
      }
      const stop = (): void => {
        offFetching()
        offPaused()
        this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
      }
      const check = (): void => {
        const outcome = this.settledOutcome()
        if (outcome === null) return
        stop()
        outcome.then(resolve, reject)
      }
      this.pendingFirstValueRejects.push(tracked)
      const offFetching = this.isFetching.subscribeChanges(check)
      const offPaused = this.isPaused.subscribeChanges(check)
    })
  }

  /** What `settled()` settles with now, or `null` while a request is in flight or parked. */
  private settledOutcome(): Promise<TPage[]> | null {
    if (this.isFetching.peek() || this.isPaused.peek()) return null
    const status = this.status.peek()
    if (status === 'success') return Promise.resolve(this.pages.peek())
    if (status === 'error') return Promise.reject(this.error.peek())
    return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  }

  isStaleNow(): boolean {
    if (this.forcedStale) return true
    const last = this.lastUpdatedAt.peek()
    if (last === undefined) return true
    return Date.now() - last >= this.staleTime
  }

  /**
   * The backoff before the next attempt, or `null` when the policy says stop.
   * An abort never retries. Throws when the query's `retry` or `retryDelay`
   * callback throws; both loops settle that as the attempt's failure.
   */
  private nextRetryDelay(attempt: number, err: unknown): number | null {
    if (isAbortError(err)) return null
    const retry = this.retry
    if (retry === false) return null
    const again = typeof retry === 'number' ? attempt < retry : retry(attempt, err)
    return again ? this.computeRetryDelay(attempt) : null
  }

  /**
   * Settle a failed request: `error` set, `status: 'error'`, the in-flight
   * flags cleared, and the loaded pages kept. `cause` is passed only when
   * `err` replaced the fetch's own error (a throwing retry callback).
   */
  private settleFailure(
    err: unknown,
    attempt: number,
    direction: 'initial' | 'next' | 'prev',
    ...cause: [] | [unknown]
  ): void {
    batch(() => {
      this.error.set(err)
      this.status.set('error')
      this.isLoading.set(false)
      this.isFetching.set(false)
      if (direction === 'next') this.isFetchingNextPage.set(false)
      if (direction === 'prev') this.isFetchingPreviousPage.set(false)
    })
    this.lastFailure =
      cause.length === 0 ? { error: err, attempt } : { error: err, attempt, cause: cause[0] }
    this.announceFetchError(err)
  }

  private computeRetryDelay(attempt: number): number {
    const d = this.retryDelay
    // Exponential backoff default when retries are on but no retryDelay given
    // (mirrors Entry.computeDelay — T3.9).
    if (d === undefined) return Math.min(1000 * 2 ** attempt, 30_000)
    return typeof d === 'function' ? d(attempt) : d
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  }

  private scheduleDeferredFetch(direction: 'initial' | 'next' | 'prev'): Promise<unknown> {
    // Parked waiting for reconnect (T3.5). Cleared when a fetch actually
    // starts (`startFetch` batch) or on drain.
    this.isPaused.set(true)
    if (this.reconnectUnsub === null) {
      this.reconnectUnsub = subscribeReconnect(() => this.drainDeferred())
    }
    return new Promise<unknown>((resolve, reject) => {
      this.deferredResolvers.push({ direction, resolve, reject })
    })
  }

  /** Run a parked request now, if the network is back. See `Entry.resumeParked`. */
  resumeParked(): void {
    if (!this.isOffline()) this.drainDeferred()
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
    // Resolves with the first page when an `'initial'` request ran: a parked
    // `startFetch` (and the `prefetch` behind it) resolves with it, as one
    // made online does (§5.7).
    const run = async (): Promise<TPage | undefined> => {
      let firstPage: TPage | undefined
      for (const dir of order) {
        if (!seen.has(dir)) continue
        if (dir === 'initial') firstPage = await this.startFetch()
        else if (dir === 'next') await this.fetchNextPage()
        else await this.fetchPreviousPage()
      }
      return firstPage
    }
    // `run` starts its first request synchronously. Clearing `isPaused` in the
    // same batch means no observer sees the entry idle and unpaused before it.
    let running: Promise<TPage | undefined> | undefined
    batch(() => {
      this.isPaused.set(false)
      running = run()
    })
    ;(running as Promise<TPage | undefined>).then(
      (firstPage) => {
        for (const p of pending) p.resolve(p.direction === 'initial' ? firstPage : undefined)
      },
      (err) => {
        for (const p of pending) p.reject(err)
      },
    )
  }

  /**
   * Write hydrated pages as the entry's canonical state: supersede any fetch
   * in flight, honor the server's timestamp for staleness. A row older than
   * the server truth the pages hold is skipped, and one older than the latest
   * invalidation makes a held entry catch up. Mirrors `Entry.applyHydration`,
   * and returns whether the row was written; the client reports the write.
   */
  applyHydration(pages: TPage[], pageParams: PageParam[], serverUpdatedAt: number): boolean {
    if (this.disposed) return false
    const lastUpdatedAt = notInFuture(serverUpdatedAt)
    const current = this.serverUpdatedAt
    if (current !== undefined && lastUpdatedAt < current) return false
    const discarded = this.currentRequest
    this.currentFetchId += 1
    this.currentAbort?.abort()
    this.currentAbort = null
    for (const sn of this.snapshots) {
      sn.prev = pages
      sn.prevParams = pageParams
    }
    // A row stamped at or after the latest `markStale()` reconciles it; an
    // older one leaves it in force (§5.7, as `Entry.applyHydration`).
    if (lastUpdatedAt >= this.staleSince) this.forcedStale = false
    batch(() => {
      this.pages.set(pages)
      this.pageParams.set(pageParams)
      this.error.set(undefined)
      this.status.set('success')
      this.isLoading.set(false)
      this.isFetching.set(false)
      this.isFetchingNextPage.set(false)
      this.isFetchingPreviousPage.set(false)
      this.markServerWrite(lastUpdatedAt)
      this.settleStaleness(lastUpdatedAt)
      this.catchUpIfStillStale(discarded)
    })
    return true
  }

  /** `isStale` from the payload's real age, and a timer for the remainder. */
  private settleStaleness(lastUpdatedAt: number | undefined): void {
    if (this.staleTimer != null) {
      this.staleTimer()
      this.staleTimer = null
    }
    const age = lastUpdatedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - lastUpdatedAt
    const alreadyStale = this.forcedStale || this.staleTime === 0 || age >= this.staleTime
    this.isStale.set(alreadyStale)
    if (!alreadyStale) {
      this.staleTimer = scheduleExpiry(this.staleTime - age, () => {
        this.staleTimer = null
        if (!this.disposed) this.isStale.set(true)
      })
    }
  }

  /** `offlineFirst`: a network-shaped failure (`TypeError`) while offline. */
  private parksOnOffline(err: unknown): boolean {
    return this.networkMode === 'offlineFirst' && this.isOffline() && err instanceof TypeError
  }

  /**
   * Park a fetch that hit a network error offline: settle the flags and wait
   * for reconnect, in one batch, so no observer sees the entry settled and
   * unpaused in between (`settled()` would take that for a cancel).
   */
  private park(direction: 'initial' | 'next' | 'prev'): Promise<unknown> {
    let parked: Promise<unknown> | undefined
    batch(() => {
      this.isFetching.set(false)
      this.isLoading.set(false)
      this.isFetchingNextPage.set(false)
      this.isFetchingPreviousPage.set(false)
      this.status.set(this.pages.peek().length > 0 ? 'success' : 'idle')
      parked = this.scheduleDeferredFetch(direction)
    })
    return parked as Promise<unknown>
  }

  private announceFetchStart(): void {
    this.fetchStartTime = Date.now()
    this.fetchCauseId = nextFetchCauseId()
    this.announce(() => this.events.onFetchStart?.(this.fetchCauseId))
  }

  private announceFetchSuccess(): void {
    const ms = Date.now() - this.fetchStartTime
    this.announce(() => this.events.onFetchSuccess?.(ms, this.pages.peek(), this.fetchCauseId))
  }

  private announceFetchError(err: unknown): void {
    const ms = Date.now() - this.fetchStartTime
    this.announce(() => this.events.onFetchError?.(ms, err, this.fetchCauseId))
  }

  /** Devtools handlers must not break the program. */
  private announce(fn: () => void): void {
    try {
      fn()
    } catch {
      // swallowed on purpose
    }
  }

  private scheduleStaleness(): void {
    if (this.staleTimer != null) this.staleTimer()
    if (this.staleTime > 0) {
      this.staleTimer = scheduleExpiry(this.staleTime, () => {
        this.staleTimer = null
        if (!this.disposed) this.isStale.set(true)
      })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.staleTimer != null) {
      this.staleTimer()
      this.staleTimer = null
    }
    this.currentAbort?.abort()
    this.currentAbort = null
    // A disposed entry is idle — reset the in-flight flags so `waitForIdle`
    // can't hang on a fetch racing dispose (T3.9). Mirrors `Entry.dispose`.
    batch(() => {
      this.isFetching.set(false)
      this.isLoading.set(false)
      this.isFetchingNextPage.set(false)
      this.isFetchingPreviousPage.set(false)
    })
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
