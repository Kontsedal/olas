import { createInfiniteQueryActions, createQueryActions, singleClient } from './actions'
import type { QueryClient } from './client'
import type { InfiniteQuery, InfiniteQuerySpec } from './infinite'
import { type RegisteredQuery, registerQueryById } from './plugin'
import type { Query, QuerySpec } from './types'

const warnedMissingId = new WeakSet<object>()

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

/** Define a shared query. Explicit queryId is required for SSR serialization. */
export function defineQuery<Args extends unknown[], T>(spec: QuerySpec<Args, T>): Query<Args, T> {
  const clients = new Set<QueryClient>()
  const query = {
    __olas: 'query' as const,
    __spec: spec,
    __id: spec.queryId,
    __clients: clients,
  } as Query<Args, T> & {
    __spec: QuerySpec<Args, T>
    __id: string | undefined
    __clients: Set<QueryClient>
  }
  Object.assign(
    query,
    createQueryActions(query, () => singleClient(clients)),
  )
  registerQueryId(spec, query)
  return query
}

/** Define a shared paginated query with operations scoped by bindQuery. */
export function defineInfiniteQuery<Args extends unknown[], PageParam, TPage, TItem = TPage>(
  spec: InfiniteQuerySpec<Args, PageParam, TPage, TItem>,
): InfiniteQuery<Args, TPage, TItem> {
  const clients = new Set<QueryClient>()
  const query = {
    __olas: 'infiniteQuery' as const,
    __spec: spec,
    __id: spec.queryId,
    __clients: clients,
  } as InfiniteQuery<Args, TPage, TItem> & {
    __spec: typeof spec
    __id: string | undefined
    __clients: Set<QueryClient>
  }
  Object.assign(
    query,
    createInfiniteQueryActions(query, () => singleClient(clients)),
  )
  registerQueryId(spec, query)
  return query
}
