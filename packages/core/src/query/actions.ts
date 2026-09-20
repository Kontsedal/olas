import type { QueryClient } from './client'
import type { InfiniteQuery, InfiniteQueryActions } from './infinite'
import type { Query, QueryActions, Snapshot } from './types'

type ClientResolver = () => QueryClient | undefined

const emptySnapshot = (): Snapshot => ({ rollback() {}, finalize() {} })

/** Resolve before doing any work: an ambiguous operation must be atomic. */
export function singleClient(clients: Set<QueryClient>): QueryClient | undefined {
  if (clients.size > 1) {
    throw new Error(
      '[olas] Query operation is ambiguous across multiple roots. ' +
        'Use bindQuery(ctx, query) or root.bindQuery(query).',
    )
  }
  return clients.values().next().value
}

export function createQueryActions<Args extends unknown[], T>(
  query: Query<Args, T>,
  getClient: ClientResolver,
): QueryActions<Args, T> {
  return {
    async invalidate(...args) {
      await getClient()?.invalidate(query, args)
    },
    async invalidateAll() {
      await getClient()?.invalidateAll(query)
    },
    cancel(...args) {
      getClient()?.cancel(query, args)
    },
    cancelAll() {
      getClient()?.cancelAll(query)
    },
    setData(...rest) {
      const updater = rest[rest.length - 1] as (prev: T | undefined) => T
      return (
        getClient()?.setData(query, rest.slice(0, -1) as unknown as Args, updater) ??
        emptySnapshot()
      )
    },
    write(...rest) {
      const updater = rest[rest.length - 1] as (prev: T | undefined) => T
      getClient()?.writeData(query, rest.slice(0, -1) as unknown as Args, updater)
    },
    replace(...rest) {
      const value = rest[rest.length - 1] as T
      getClient()?.replaceData(query, rest.slice(0, -1) as unknown as Args, value)
    },
    peek(...args) {
      return getClient()?.peekData(query, args)
    },
    async prefetch(...args) {
      const client = getClient()
      if (!client)
        throw new Error(
          '[olas] prefetch called before any root has subscribed; use root.bindQuery(query)',
        )
      return client.prefetch(query, args)
    },
  }
}

export function createInfiniteQueryActions<Args extends unknown[], TPage, TItem>(
  query: InfiniteQuery<Args, TPage, TItem>,
  getClient: ClientResolver,
): InfiniteQueryActions<Args, TPage, TItem> {
  return {
    async invalidate(...args) {
      await getClient()?.invalidateInfinite(query, args)
    },
    async invalidateAll() {
      await getClient()?.invalidateAllInfinite(query)
    },
    cancel(...args) {
      getClient()?.cancelInfinite(query, args)
    },
    cancelAll() {
      getClient()?.cancelAllInfinite(query)
    },
    setData(...rest) {
      const updater = rest[rest.length - 1] as (prev: TPage[] | undefined) => TPage[]
      return (
        getClient()?.setInfiniteData(query, rest.slice(0, -1) as unknown as Args, updater) ??
        emptySnapshot()
      )
    },
    async prefetch(...args) {
      const client = getClient()
      if (!client)
        throw new Error(
          '[olas] prefetch called before any root has subscribed; use root.bindQuery(query)',
        )
      return client.prefetchInfinite(query, args)
    },
  }
}
