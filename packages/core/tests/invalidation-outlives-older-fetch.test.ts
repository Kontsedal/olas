/**
 * An invalidation stays in force until data requested after it lands (SPEC §5.7).
 *
 * With no subscribers, `invalidate` only marks the entry stale. A fetch that started
 * before the invalidation can still be running, because a released entry keeps its
 * fetch for the gc window. Its response is older than the invalidation, so it must not
 * clear the stale mark: the next subscriber still has to refetch. It used to clear it,
 * and with `staleTime: Infinity` the pre-invalidation data then stayed forever.
 */
import { describe, expect, test } from 'vitest'
import { createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('an invalidation outlives a fetch that started before it', () => {
  test('the reviewer reproduction: the next subscriber refetches', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/regular',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve('fresh')
      },
      staleTime: 60_000,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        s: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    expect(calls).toBe(1)
    // The subscriber leaves mid-fetch; the entry keeps its fetch for the gc window.
    enabled.set(false)
    // A mutation invalidates while nobody subscribes: the entry is marked stale only.
    await q.invalidateAll()
    // The response requested before the invalidation arrives.
    first.resolve('old')
    await flush()
    enabled.set(true)
    await flush()
    expect(calls).toBe(2)
    expect(root.api.s.data.value).toBe('fresh')
    root.dispose()
  })

  test('staleTime: Infinity does not keep the pre-invalidation data forever', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/infinity',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve('fresh')
      },
      staleTime: Number.POSITIVE_INFINITY,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        s: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    enabled.set(false)
    await q.invalidate()
    first.resolve('old')
    await flush()
    enabled.set(true)
    await flush()
    expect(root.api.s.data.value).toBe('fresh')
    expect(root.api.s.isStale.value).toBe(false)
    root.dispose()
  })

  test('the older response still lands, and the entry reads stale until the refetch', async () => {
    const first = deferred<string>()
    const q = defineQuery({
      id: 'invalidation-outlives/stale-signal',
      key: () => ['k'],
      fetcher: () => first.promise,
      staleTime: 60_000,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        s: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    const peek = root.bindQuery(q)
    enabled.set(false)
    await peek.invalidate()
    first.resolve('old')
    await flush()
    // The data is kept: it is the best the cache has until someone refetches.
    expect(peek.peek()).toBe('old')
    expect(root.debug.queryEntries()[0]?.isStale).toBe(true)
    root.dispose()
  })

  test('a fetch that starts after the invalidation clears it', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/cleared',
      key: () => ['k'],
      fetcher: async () => {
        calls += 1
        return calls
      },
      staleTime: 60_000,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        s: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    await flush()
    enabled.set(false)
    await q.invalidate()
    enabled.set(true)
    await flush()
    expect(calls).toBe(2)
    // The refetch was requested after the invalidation, so it reconciled it.
    enabled.set(false)
    enabled.set(true)
    await flush()
    expect(calls).toBe(2)
    root.dispose()
  })

  test('an infinite query: the older refetch leaves the invalidation in force', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'invalidation-outlives/infinite',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve('fresh')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        s: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    enabled.set(false)
    await q.invalidateAll()
    first.resolve('old')
    await flush()
    enabled.set(true)
    await flush()
    expect(calls).toBe(2)
    expect(root.api.s.pages.value).toEqual(['fresh'])
    root.dispose()
  })
})
