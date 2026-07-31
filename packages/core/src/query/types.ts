import type { ReadSignal } from '../signals/types'

/** Lifecycle phase of an async resource. */
export type AsyncStatus = 'idle' | 'pending' | 'success' | 'error'

/**
 * The nine reactive signals + three actions a subscriber sees for any async
 * resource (`LocalCache<T>` or a `Query` subscription). Spec §20.4.
 *
 * - `data` / `error` / `status` — current outcome.
 * - `isLoading` — true only on the first pending fetch (no `data` yet).
 * - `isFetching` — true on any pending fetch.
 * - `isStale` — true when `staleTime` has elapsed since `lastUpdatedAt`.
 * - `lastUpdatedAt` — epoch ms of last success.
 * - `hasPendingMutations` — at least one mutation has a snapshot on this entry.
 * - `isPaused` — a fetch is parked waiting for network reconnect.
 *
 * Actions:
 * - `refetch()` — force a fetch; resolves with the result.
 * - `reset()` — clear `error` + `status` without re-fetching.
 * - `firstValue()` — resolves on the first success after subscribe.
 */
export type AsyncState<T> = {
  data: ReadSignal<T | undefined>
  error: ReadSignal<unknown | undefined>
  status: ReadSignal<AsyncStatus>
  isLoading: ReadSignal<boolean>
  isFetching: ReadSignal<boolean>
  isStale: ReadSignal<boolean>
  lastUpdatedAt: ReadSignal<number | undefined>
  hasPendingMutations: ReadSignal<boolean>
  /**
   * True while a fetch is parked waiting for network reconnect — either an
   * `online`-mode fetch deferred because `navigator.onLine` was `false`, or an
   * `offlineFirst` fetch that hit a network error while offline and is waiting
   * to retry on reconnect. Distinct from `isFetching` (nothing is in flight
   * while parked) and from `status` (stays `idle` / last-success, never
   * flips to `error` for the parked attempt). Spec §5.5.
   */
  isPaused: ReadSignal<boolean>

  refetch: () => Promise<T>
  reset: () => void
  firstValue: () => Promise<T>
  /**
   * Alias of `firstValue()` — clearer name for Suspense / `React.use(...)`
   * use cases. Resolves with `data` on first success (short-circuits if
   * already settled), rejects with `error` on the first failure. Use this
   * to suspend a React tree until the query lands its first value.
   */
  promise: () => Promise<T>
}

/**
 * Returned by `query.setData(...)` or `localCache.setData(...)`. Used by
 * `mutation.onMutate` for optimistic-update rollback (spec §6.4).
 *
 * - `rollback()` restores the previous data state (and clears the
 *   "pending mutation" flag on the entry if no other snapshots are live).
 * - `finalize()` commits the snapshot as the new truth — no rollback,
 *   `hasPendingMutations` clears once all live snapshots on the entry
 *   are finalized or rolled back. The mutation runner calls this on
 *   success; user code rarely needs to.
 *
 * Both are idempotent and mutually exclusive (calling one disables the
 * other). Safe to call after the owning entry has been disposed.
 */
export type Snapshot = {
  rollback: () => void
  finalize: () => void
}

/**
 * A cache owned by one controller — no sharing across the tree. Returned by
 * `ctx.cache(fetcher, options?)`. Disposed automatically with the controller.
 */
export type LocalCache<T> = AsyncState<T> & {
  /** Mark stale and trigger an immediate refetch. */
  invalidate(): void
  /** Patch the current data. Returns a `Snapshot` for rollback. */
  setData(updater: (prev: T | undefined) => T): Snapshot
  /** Idempotent — also called when the owning controller disposes. */
  dispose(): void
}

/** One entry inside a `DehydratedState`. */
export type DehydratedEntry = {
  /**
   * Stable query identity — `spec.queryId` when set, else an auto-assigned
   * registration id. Namespaces the hydration buffer so a subscriber of query
   * B can't adopt query A's payload just because their `key()` outputs hash
   * the same (spec §15).
   */
  id: string
  key: readonly unknown[]
  data: unknown
  lastUpdatedAt: number
}

/**
 * SSR-serializable snapshot of a root's `QueryClient`. Produced by
 * `root.dehydrate()` on the server; consumed by
 * `createRoot(def, { hydrate: state })` on the client. Spec §15, §20.9.
 */
export type DehydratedState = {
  version: 1
  entries: DehydratedEntry[]
}

/**
 * Retry policy for queries and mutations. A number is a max-attempt count
 * (default backoff). A function decides per-attempt (return `true` to retry).
 */
export type RetryPolicy = number | ((attempt: number, error: unknown) => boolean)

/** Backoff in ms. A number is constant delay; a function computes per-attempt. */
export type RetryDelay = number | ((attempt: number) => number)

/**
 * Periodic background refetch while an entry has subscribers. A number is a
 * fixed gap in ms. A function is resolved **once per scheduling decision** —
 * on every tick, for the *next* gap — and receives the entry's latest data
 * through a non-subscribing read:
 *
 * ```ts
 * // Poll fast while there's work in flight, slowly when idle.
 * refetchInterval: (jobs) => (jobs?.some((j) => j.state === 'running') ? 1_000 : 30_000)
 * ```
 *
 * The contract:
 *
 * - **The gap must be a positive finite number — in both forms.** `0` / `NaN` /
 *   negative / `Infinity` stops the timer for that entry instead of scheduling
 *   a hot loop; dev builds warn. This covers a literal (`refetchInterval: 0`
 *   never arms, where it used to mean "fetch every macrotask") as well as a
 *   thunk's return. Once stopped, the timer restarts only on the entry's next
 *   **0→1 subscriber transition** — a subscriber joining an entry that still
 *   has others does not re-arm it.
 * - **A thunk must not throw.** A throw is treated exactly like a bad return —
 *   the chain stops, with a dev warning naming the throw (and carrying the
 *   error) so it can't die silently. Keep the thunk to a pure arithmetic
 *   decision over `data`; do the risky part elsewhere.
 * - **The first resolution is synchronous, at acquire.** The 0→1 subscriber
 *   arms the chain before the initial fetch can settle, so the thunk's first
 *   call receives `undefined` (or hydrated/cached data if the entry already
 *   has some). Handle that argument rather than assuming a loaded entry.
 * - **Not reactive.** Reading a signal inside the thunk gives its current
 *   value for that tick and registers no dependency — changing it later
 *   reschedules nothing. Drive the decision off the `data` argument.
 * - **Per entry, not per subscriber.** The timer belongs to the shared cache
 *   entry, so ten controllers on one key share one interval. That's why
 *   `UseOptions` has no `refetchInterval`: per-subscriber intervals need a
 *   "whose interval wins" rule and every answer to that surprises somebody.
 *   Same reason it stays out of `DefaultQueryOptions` (§5.9) — a root-wide
 *   interval polls the entire app.
 * - `ctx.cache` (`LocalCache`) has no interval of any kind. This is a
 *   `defineQuery` / `defineInfiniteQuery` feature only.
 *
 * For infinite queries `T` is the pages array (`TPage[]`) — whatever the entry
 * stores, `undefined` until the first page lands. Spec §5.9.
 */
export type RefetchInterval<T> = number | ((data: T | undefined) => number)

/**
 * Per-fetch context: the `AbortSignal` to honor + the root's `deps`. Passed
 * as the first argument to every `QuerySpec.fetcher` invocation so module-
 * level queries can reach their dependencies without resorting to globals.
 */
export type FetchCtx = {
  signal: AbortSignal
  deps: import('../controller/types').AmbientDeps
}

/**
 * Configuration passed to `defineQuery({ ... })`. The `Args` tuple is what
 * callers pass as cache keys and to the fetcher. Spec §20.4.
 *
 * The fetcher's first argument is a `FetchCtx` (signal + deps); positional
 * cache args come after. This shape lets module-scoped queries read
 * `ctx.deps.api` etc. — no `setApiForQuery(api)` module-level capture needed.
 */
/**
 * How a query behaves with respect to the network reachability signal.
 *
 * - `online` (default) — pause fetches while `navigator.onLine` is `false`;
 *   automatically resume when reconnect fires (via `subscribeReconnect`).
 *   Inflight fetches are NOT aborted on offline; a `bindEntry` / `acquire`
 *   that lands while offline simply defers the initial fetch. The deferred
 *   entry reports `isPaused: true` until reconnect.
 * - `always` — never gate on connectivity; fetcher runs whenever requested.
 *   Useful for queries against `localhost` / IPC / a service worker that
 *   doesn't surface through `navigator.onLine`.
 * - `offlineFirst` — start the fetch regardless; if it rejects with a
 *   network-shaped error (a `fetch` `TypeError`; `AbortError` excluded) while
 *   `navigator.onLine` is `false`, park the entry (`isPaused: true`, status
 *   stays `idle` / last-success) and retry on reconnect rather than surfacing
 *   the error. Matches TanStack's `offlineFirst` policy for app-shell-first
 *   PWAs.
 */
export type NetworkMode = 'online' | 'always' | 'offlineFirst'

export type QuerySpec<Args extends unknown[], T> = {
  key: (...args: Args) => unknown[]
  fetcher: (ctx: FetchCtx, ...args: Args) => Promise<T>
  staleTime?: number
  gcTime?: number
  /**
   * Fixed gap in ms, or a thunk over the entry's latest data resolved once per
   * tick — see `RefetchInterval` for the contract. Spec §5.9.
   */
  refetchInterval?: RefetchInterval<T>
  refetchOnWindowFocus?: boolean
  refetchOnReconnect?: boolean
  keepPreviousData?: boolean
  retry?: RetryPolicy
  retryDelay?: RetryDelay
  /**
   * Network-mode policy. Defaults to `'online'`. See `NetworkMode` for the
   * three policies. Override per-query for special cases (e.g. `'always'`
   * for `localhost` queries that don't surface through `navigator.onLine`).
   */
  networkMode?: NetworkMode
  /**
   * Whether to run `structuralShare(prev, next)` after a successful fetch.
   * Defaults to `true`. Set `false` for queries returning large payloads
   * (e.g. a 100k-row table) where the O(payload) deep walk on every poll
   * is more expensive than re-rendering. With `false`, `applySuccess`
   * writes the fetcher's result directly.
   */
  structuralShare?: boolean
  /**
   * Stable identifier used by `QueryClientPlugin`s (e.g. `@kontsedal/olas-cross-tab`)
   * to locate the same query across tabs / processes / persistence layers.
   * REQUIRED for queries with `crossTab: true`. SPEC §13.2.
   *
   * Don't auto-derive from `fetcher.name` or argument hashing — both are
   * fragile under minification.
   */
  queryId?: string
  /**
   * Opt this query into cross-tab cache sync (`@kontsedal/olas-cross-tab`).
   * No effect without a `queryId` and without a plugin installed. SPEC §13.2.
   *
   * - `true` (legacy) — equivalent to `'data'`.
   * - `'data'` — propagate explicit `setData`/`invalidate` writes.
   *
   * The `'infinite'` / `'both'` values were removed (T6.4): peers can't apply
   * infinite-query page arrays cross-tab, so those broadcasts were channel
   * noise. Infinite cross-tab is tracked in `BACKLOG.md`.
   */
  crossTab?: boolean | 'data'
}

/**
 * Root-wide defaults for query behavior, passed as
 * `createRoot(def, { defaultQueryOptions })`. Every field mirrors the
 * same-named field on `QuerySpec` — resolution is
 * `spec.X ?? defaultQueryOptions.X ?? <built-in default>`, so a per-query
 * spec always wins. Spec §5.9.
 *
 * Derived via `Pick` rather than re-declared so the types can't drift from
 * `QuerySpec`. None of the picked fields reference `Args`/`T`, which is why
 * instantiating with `never[]` / `unknown` is safe here.
 *
 * Deliberately NOT defaultable:
 * - `refetchInterval` — a root-wide interval would silently start polling
 *   every query in the app. Opt in per query.
 * - `key` / `fetcher` / `queryId` / `crossTab` — per-query identity and
 *   behavior; meaningless as an app-wide default.
 *
 * `refetchOnWindowFocus` / `refetchOnReconnect` apply to regular queries
 * only — infinite queries have no focus/reconnect subscription (see
 * `InfiniteClientEntry`), so setting them here is a no-op for those.
 */
export type DefaultQueryOptions = Pick<
  QuerySpec<never[], unknown>,
  | 'staleTime'
  | 'gcTime'
  | 'refetchOnWindowFocus'
  | 'refetchOnReconnect'
  | 'keepPreviousData'
  | 'retry'
  | 'retryDelay'
  | 'networkMode'
  | 'structuralShare'
>

/**
 * A module-scoped shared query handle. Bind a subscriber via
 * `ctx.use(query, () => [...args])`. The same `Query` value can be used by
 * many controllers across many roots — each root has its own cache.
 */
export type Query<Args extends unknown[], T> = {
  readonly __olas: 'query'
  /** Mark a specific keyed entry stale + trigger refetch if any subscribers. */
  invalidate(...args: Args): void
  /** Mark every keyed entry stale + trigger refetch on all subscribers. */
  invalidateAll(): void
  /** Patch the current data for a specific key. Returns a `Snapshot` for rollback. */
  setData(...args: [...Args, updater: (prev: T | undefined) => T]): Snapshot
  /**
   * Cancel the in-flight fetch for a specific key (if any). Aborts + supersedes
   * it, restores a settled status (`'success'` if data exists, else `'idle'`),
   * and does NOT touch data. Use before an optimistic `setData` so an
   * outgoing refetch's stale response can't clobber it (spec §5, §6.4).
   */
  cancel(...args: Args): void
  /** Cancel in-flight fetches for every keyed entry of this query. */
  cancelAll(): void
  /** Eagerly fetch into the cache without subscribing. */
  prefetch(...args: Args): Promise<T>
}

/** What `ctx.use(query, ...)` returns — `AsyncState<T>` plus `cancel()`. */
export type QuerySubscription<T> = AsyncState<T> & {
  /** Cancel this subscription's in-flight fetch (if any). See `Query.cancel`. */
  cancel: () => void
}

/**
 * Options passed to `ctx.use(query, opts)` to control the subscription
 * (reactive key, enabled-gating). The `key` thunk reads signals —
 * re-evaluating when they change re-keys the subscription.
 *
 * A `select` projection that maps the underlying data shape to a view
 * shape is accepted via a dedicated overload on `Ctx.use` rather than this
 * options bag — the overload threads `T → U` types through cleanly.
 */
export type UseOptions<Args extends readonly unknown[]> = {
  key?: () => Args
  enabled?: () => boolean
}

/**
 * Internal shape — what `createUse` accepts. Includes the optional `select`
 * field used by the `select` overload on `Ctx.use`. Not exported on the
 * public surface; consumers use the typed overload.
 */
export type UseInternalOptions<Args extends readonly unknown[], T, U> = UseOptions<Args> & {
  select?: (data: T) => U
}
