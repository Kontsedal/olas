import type { QueryClient } from './client'
import type { InfiniteQuery, InfiniteQuerySpec } from './infinite'
import { type RegisteredQuery, registerQueryById } from './plugin'
import type { Query, QuerySpec, Snapshot } from './types'

type QueryInternal<Args extends unknown[], T> = Query<Args, T> & {
  readonly __spec: QuerySpec<Args, T>
  /** Stable identity for SSR hydration matching — see `assignQueryId`. */
  readonly __id: string
  __clients: Set<QueryClient>
}

const warnedMissingId = new WeakSet<object>()

/**
 * Assign a stable identity used to namespace SSR dehydrate/hydrate so a
 * subscriber of one query can't adopt a colliding-key payload from another
 * (spec §15). Prefer the explicit `queryId` (which doubles as the plugin
 * routing id, so `__id === queryId` there); otherwise auto-assign a
 * registration id. Auto ids are stable across a server/client pair that
 * evaluate the same bundle in the same order (the common, non-code-split
 * case). If they ever drift (code-split, differing import order), the
 * mismatch degrades *safely* to a hydration miss + refetch — never a
 * cross-query adoption. Set an explicit `queryId` for a hard guarantee. The
 * ` ` prefix keeps auto ids out of the practical user-string namespace (JSON-safe).
 */
let autoQueryIdCounter = 0
function assignQueryId(spec: { queryId?: string }): string {
  return spec.queryId ?? ` auto:${autoQueryIdCounter++}`
}

function registerQueryId(
  // The param stays wide so a JS / cast caller passing a removed value is
  // caught at runtime; the PUBLIC `QuerySpec.crossTab` type is `boolean | 'data'`.
  spec: { queryId?: string; crossTab?: boolean | 'data' | 'infinite' | 'both' },
  query: object,
): void {
  if (__DEV__ && (spec.crossTab === 'infinite' || spec.crossTab === 'both')) {
    // Removed in T6.4: core's `applyRemoteSetData` / `applyRemoteInvalidate`
    // early-return for infinite (non-`'query'`) defs, so an infinite/both
    // broadcast was pure channel noise no peer could apply. Degrade to `'data'`
    // (regular writes still sync). Infinite cross-tab is tracked in BACKLOG.md.
    console.warn(
      "[olas] crossTab: 'infinite' / 'both' is no longer supported — peers can't apply " +
        "infinite-query page arrays cross-tab. Treated as 'data' (regular writes still sync).",
    )
  }
  if (spec.queryId != null) {
    registerQueryById(spec.queryId, query as RegisteredQuery)
  } else if (spec.crossTab === true) {
    // Plugins can't route a message without a `queryId`. Warn once per
    // offending spec — repeated warnings on every render would be noisy.
    if (__DEV__ && !warnedMissingId.has(spec as object)) {
      warnedMissingId.add(spec as object)
      console.warn(
        '[olas] defineQuery({ crossTab: true }) requires a stable `queryId`. ' +
          'Add `queryId: "<unique-string>"` to the spec. Cross-tab sync is disabled for this query.',
      )
    }
  }
}

/**
 * Define a keyed, shared query. The returned Query value lives at module
 * scope; per-root QueryClients bind their own entry registries to it.
 */
export function defineQuery<Args extends unknown[], T>(spec: QuerySpec<Args, T>): Query<Args, T> {
  const clients = new Set<QueryClient>()
  const query = {
    __olas: 'query' as const,
    __spec: spec,
    __id: assignQueryId(spec),
    __clients: clients,

    invalidate(...args: Args): Promise<void> {
      const settled: Promise<void>[] = []
      for (const client of clients) {
        settled.push(client.invalidate(query as Query<Args, T>, args))
      }
      return Promise.all(settled).then(() => {})
    },

    invalidateAll(): Promise<void> {
      const settled: Promise<void>[] = []
      for (const client of clients) {
        settled.push(client.invalidateAll(query as Query<Args, T>))
      }
      return Promise.all(settled).then(() => {})
    },

    cancel(...args: Args): void {
      for (const client of clients) {
        client.cancel(query as Query<Args, T>, args)
      }
    },

    cancelAll(): void {
      for (const client of clients) {
        client.cancelAll(query as Query<Args, T>)
      }
    },

    setData(...rest: [...Args, updater: (prev: T | undefined) => T]): Snapshot {
      const updater = rest[rest.length - 1] as (prev: T | undefined) => T
      const keyArgs = rest.slice(0, -1) as unknown as Args
      const childSnapshots: Snapshot[] = []
      for (const client of clients) {
        childSnapshots.push(client.setData(query as Query<Args, T>, keyArgs, updater))
      }
      return {
        rollback: () => {
          for (const s of childSnapshots) s.rollback()
        },
        finalize: () => {
          for (const s of childSnapshots) s.finalize()
        },
      }
    },

    write(...rest: [...Args, updater: (prev: T | undefined) => T]): void {
      const updater = rest[rest.length - 1] as (prev: T | undefined) => T
      const keyArgs = rest.slice(0, -1) as unknown as Args
      for (const client of clients) {
        client.writeData(query as Query<Args, T>, keyArgs, updater)
      }
    },

    replace(...rest: [...Args, value: T]): void {
      const value = rest[rest.length - 1] as T
      const keyArgs = rest.slice(0, -1) as unknown as Args
      for (const client of clients) {
        client.replaceData(query as Query<Args, T>, keyArgs, value)
      }
    },

    peek(...args: Args): T | undefined {
      // First client holding data wins. Unlike `prefetch` this neither throws on
      // zero clients (no root subscribed yet is a legitimate "nothing cached")
      // nor warns on several: a read is side-effect-free, and warning would fire
      // from the hot paths peek exists for (click handlers, event folds).
      for (const client of clients) {
        const data = client.peekData(query as Query<Args, T>, args)
        if (data !== undefined) return data
      }
      return undefined
    },

    prefetch(...args: Args): Promise<T> {
      // Single-client common case; if none, throw.
      const [first] = clients
      if (!first) {
        return Promise.reject(new Error('[olas] prefetch called before any root has subscribed'))
      }
      if (__DEV__ && clients.size > 1) {
        // eslint-disable-next-line no-console
        console.warn(
          '[olas] query.prefetch() is ambiguous when multiple roots are registered; ' +
            'using an arbitrary root. Call `root.prefetch(query, args)` (or per-root) to be explicit.',
        )
      }
      return first.prefetch(query as Query<Args, T>, args)
    },
  } satisfies QueryInternal<Args, T>

  registerQueryId(spec, query)
  return query as Query<Args, T>
}

type InfiniteQueryInternal<Args extends unknown[], TPage, TItem> = InfiniteQuery<
  Args,
  TPage,
  TItem
> & {
  readonly __spec: InfiniteQuerySpec<Args, any, TPage, TItem>
  /** Stable identity for SSR hydration matching — see `assignQueryId`. */
  readonly __id: string
  __clients: Set<QueryClient>
}

/**
 * Define a paginated query (chat-style "load more", infinite scrolling). Pages
 * are kept in order and concatenated via `getNextPageParam` /
 * `getPreviousPageParam`. The returned handle is module-scoped — bind
 * subscribers via `ctx.use(infiniteQuery, () => [...args])`. Spec §5.7,
 * §20.4.
 */
export function defineInfiniteQuery<Args extends unknown[], PageParam, TPage, TItem = TPage>(
  spec: InfiniteQuerySpec<Args, PageParam, TPage, TItem>,
): InfiniteQuery<Args, TPage, TItem> {
  const clients = new Set<QueryClient>()
  const query = {
    __olas: 'infiniteQuery' as const,
    __spec: spec,
    __id: assignQueryId(spec),
    __clients: clients,

    invalidate(...args: Args): Promise<void> {
      const settled: Promise<void>[] = []
      for (const client of clients) {
        settled.push(client.invalidateInfinite(query as InfiniteQuery<Args, TPage, TItem>, args))
      }
      return Promise.all(settled).then(() => {})
    },

    invalidateAll(): Promise<void> {
      const settled: Promise<void>[] = []
      for (const client of clients) {
        settled.push(client.invalidateAllInfinite(query as InfiniteQuery<Args, TPage, TItem>))
      }
      return Promise.all(settled).then(() => {})
    },

    cancel(...args: Args): void {
      for (const client of clients) {
        client.cancelInfinite(query as InfiniteQuery<Args, TPage, TItem>, args)
      }
    },

    cancelAll(): void {
      for (const client of clients) {
        client.cancelAllInfinite(query as InfiniteQuery<Args, TPage, TItem>)
      }
    },

    setData(...rest: [...Args, updater: (prev: TPage[] | undefined) => TPage[]]): Snapshot {
      const updater = rest[rest.length - 1] as (prev: TPage[] | undefined) => TPage[]
      const keyArgs = rest.slice(0, -1) as unknown as Args
      const childSnapshots: Snapshot[] = []
      for (const client of clients) {
        childSnapshots.push(
          client.setInfiniteData<Args, TPage>(
            query as InfiniteQuery<Args, TPage, TItem>,
            keyArgs,
            updater,
          ),
        )
      }
      return {
        rollback: () => {
          for (const s of childSnapshots) s.rollback()
        },
        finalize: () => {
          for (const s of childSnapshots) s.finalize()
        },
      }
    },

    prefetch(...args: Args): Promise<TPage> {
      const [first] = clients
      if (!first) {
        return Promise.reject(new Error('[olas] prefetch called before any root has subscribed'))
      }
      if (__DEV__ && clients.size > 1) {
        // eslint-disable-next-line no-console
        console.warn(
          '[olas] infiniteQuery.prefetch() is ambiguous when multiple roots are registered; ' +
            'using an arbitrary root. Call `root.prefetch(query, args)` (or per-root) to be explicit.',
        )
      }
      return first.prefetchInfinite(query as InfiniteQuery<Args, TPage, TItem>, args)
    },
  } satisfies InfiniteQueryInternal<Args, TPage, TItem>

  registerQueryId(spec, query)
  return query as InfiniteQuery<Args, TPage, TItem>
}
