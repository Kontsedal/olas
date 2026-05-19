import type { QueryClient } from './client'
import type { InfiniteQuery, InfiniteQuerySpec } from './infinite'
import { type RegisteredQuery, registerQueryById } from './plugin'
import type { Query, QuerySpec, Snapshot } from './types'

type QueryInternal<Args extends unknown[], T> = Query<Args, T> & {
  readonly __spec: QuerySpec<Args, T>
  __clients: Set<QueryClient>
}

const warnedMissingId = new WeakSet<object>()

function registerQueryId(spec: { queryId?: string; crossTab?: boolean }, query: object): void {
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
    __clients: clients,

    invalidate(...args: Args): void {
      for (const client of clients) {
        client.invalidate(query as Query<Args, T>, args)
      }
    },

    invalidateAll(): void {
      for (const client of clients) {
        client.invalidateAll(query as Query<Args, T>)
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
    __clients: clients,

    invalidate(...args: Args): void {
      for (const client of clients) {
        client.invalidateInfinite(query as InfiniteQuery<Args, TPage, TItem>, args)
      }
    },

    invalidateAll(): void {
      for (const client of clients) {
        client.invalidateAllInfinite(query as InfiniteQuery<Args, TPage, TItem>)
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
