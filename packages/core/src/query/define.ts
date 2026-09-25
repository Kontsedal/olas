import { BRAND } from '../brand'
import { createInfiniteQueryActions, createQueryActions, singleClient } from './actions'
import type { QueryClient } from './client'
import type { InfiniteQuery, InfiniteQuerySpec } from './infinite'
import type { Query, QuerySpec } from './types'

/**
 * Every shared query carries a hand-written `id`: SSR payloads, plugin events
 * and devtools all name it by that id, so a query without one would be
 * invisible to all three. Checked at runtime too, for JS callers and casts.
 */
function assertId(id: unknown, caller: string): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      `[olas] ${caller} requires a non-empty \`id\` — a stable, hand-written name that is ` +
        "the same in the server and client bundles (e.g. `id: 'users/detail'`).",
    )
  }
}

/**
 * Define a shared query, cached per root and named by its `id`. Spec §5.2.
 *
 * @example
 * ```ts
 * export const userQuery = defineQuery({
 *   id: 'users/detail',
 *   key: (id: string) => [id],
 *   fetcher: ({ signal, deps }, id) => deps.api.getUser(id, { signal }),
 *   staleTime: 30_000,
 * })
 * ```
 */
export function defineQuery<Args extends unknown[], T>(spec: QuerySpec<Args, T>): Query<Args, T> {
  assertId(spec.id, 'defineQuery')
  const clients = new Set<QueryClient>()
  const query = {
    [BRAND]: 'query' as const,
    __spec: spec,
    __id: spec.id,
    __clients: clients,
  } as Query<Args, T> & {
    __spec: QuerySpec<Args, T>
    __id: string
    __clients: Set<QueryClient>
  }
  Object.assign(
    query,
    createQueryActions(query, () => singleClient(clients)),
  )
  return query
}

/** Define a shared paginated query, named by its `id`. Spec §5.11. */
export function defineInfiniteQuery<Args extends unknown[], PageParam, TPage, TItem = TPage>(
  spec: InfiniteQuerySpec<Args, PageParam, TPage, TItem>,
): InfiniteQuery<Args, TPage, TItem> {
  assertId(spec.id, 'defineInfiniteQuery')
  const clients = new Set<QueryClient>()
  const query = {
    [BRAND]: 'infiniteQuery' as const,
    __spec: spec,
    __id: spec.id,
    __clients: clients,
  } as InfiniteQuery<Args, TPage, TItem> & {
    __spec: typeof spec
    __id: string
    __clients: Set<QueryClient>
  }
  Object.assign(
    query,
    createInfiniteQueryActions(query, () => singleClient(clients)),
  )
  return query
}
