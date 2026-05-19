import type { ReadSignal } from '../signals/types'

/** Lifecycle phase of an async resource. */
export type AsyncStatus = 'idle' | 'pending' | 'success' | 'error'

/**
 * The eight reactive signals + three actions a subscriber sees for any async
 * resource (`LocalCache<T>` or a `Query` subscription). Spec §20.4.
 *
 * - `data` / `error` / `status` — current outcome.
 * - `isLoading` — true only on the first pending fetch (no `data` yet).
 * - `isFetching` — true on any pending fetch.
 * - `isStale` — true when `staleTime` has elapsed since `lastUpdatedAt`.
 * - `lastUpdatedAt` — epoch ms of last success.
 * - `hasPendingMutations` — at least one mutation has a snapshot on this entry.
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

  refetch: () => Promise<T>
  reset: () => void
  firstValue: () => Promise<T>
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
export type QuerySpec<Args extends unknown[], T> = {
  key: (...args: Args) => unknown[]
  fetcher: (ctx: FetchCtx, ...args: Args) => Promise<T>
  staleTime?: number
  gcTime?: number
  refetchInterval?: number
  refetchOnWindowFocus?: boolean
  refetchOnReconnect?: boolean
  keepPreviousData?: boolean
  retry?: RetryPolicy
  retryDelay?: RetryDelay
}

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
  /** Eagerly fetch into the cache without subscribing. */
  prefetch(...args: Args): Promise<T>
}

/** What `ctx.use(query, ...)` returns. Alias of `AsyncState<T>`. */
export type QuerySubscription<T> = AsyncState<T>

/**
 * Options passed to `ctx.use(query, opts)` to control the subscription
 * (reactive key, enabled-gating). The `key` thunk reads signals — re-evaluating
 * when they change re-keys the subscription.
 */
export type UseOptions<Args extends readonly unknown[]> = {
  key?: () => Args
  enabled?: () => boolean
}
