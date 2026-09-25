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

/**
 * The same bug on the join paths. A subscriber that returns while the older fetch
 * is still in flight joins it rather than starting a new one, and so do `resume()`
 * and `prefetch()`. The older response lands and keeps the stale mark, which is
 * right, but the subscriber that joined it is already here, so nothing refetched.
 * The entry now catches up once when such a response lands and someone holds it
 * (SPEC §5.7).
 */
describe('a subscriber that joins the older fetch still refetches', () => {
  test('the reviewer reproduction: a regular query', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/join-regular',
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
    enabled.set(false)
    await q.invalidateAll()
    // Back before the older response lands: the subscription joins that fetch.
    enabled.set(true)
    expect(calls).toBe(1)
    first.resolve('old')
    await flush()
    expect(calls).toBe(2)
    expect(root.api.s.data.value).toBe('fresh')
    expect(root.api.s.isStale.value).toBe(false)
    expect(root.api.s.isFetching.value).toBe(false)
    root.dispose()
  })

  test('isFetching never reads false between the older response and the catch-up', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/join-no-gap',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
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
    enabled.set(false)
    await q.invalidateAll()
    enabled.set(true)
    const seen: boolean[] = []
    const off = root.api.s.isFetching.subscribe((v) => seen.push(v))
    let idle = false
    void root.waitForIdle().then(() => {
      idle = true
    })
    first.resolve('old')
    await flush()
    // The older response lands, and the catch-up keeps the entry fetching.
    expect(root.api.s.data.value).toBe('old')
    expect(seen).toEqual([true])
    expect(idle).toBe(false)
    second.resolve('fresh')
    await flush()
    expect(root.api.s.data.value).toBe('fresh')
    expect(idle).toBe(true)
    off()
    root.dispose()
  })

  test('staleTime: Infinity, resumed while the older fetch runs', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/join-resume',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve('fresh')
      },
      staleTime: Number.POSITIVE_INFINITY,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    root.suspend()
    await q.invalidateAll()
    root.resume()
    first.resolve('old')
    await flush()
    expect(calls).toBe(2)
    expect(root.api.s.data.value).toBe('fresh')
    expect(root.api.s.isStale.value).toBe(false)
    root.dispose()
  })

  test('an infinite query', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'invalidation-outlives/join-infinite',
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
    enabled.set(true)
    first.resolve('old')
    await flush()
    expect(calls).toBe(2)
    expect(root.api.s.pages.value).toEqual(['fresh'])
    expect(root.api.s.isStale.value).toBe(false)
    root.dispose()
  })

  test('an infinite query, resumed while the older fetch runs', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'invalidation-outlives/join-infinite-resume',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve('fresh')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: Number.POSITIVE_INFINITY,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    root.suspend()
    await q.invalidateAll()
    root.resume()
    first.resolve('old')
    await flush()
    expect(calls).toBe(2)
    expect(root.api.s.pages.value).toEqual(['fresh'])
    root.dispose()
  })

  test('a page request that started before the invalidation', async () => {
    const page = deferred<string>()
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'invalidation-outlives/join-page',
      key: () => ['k'],
      fetcher: ({ pageParam }: { pageParam: number }) => {
        calls += 1
        if (calls === 2) return page.promise
        return Promise.resolve(`page ${pageParam} (call ${calls})`)
      },
      initialPageParam: 0,
      getNextPageParam: (_last: string, all: string[]) => (all.length < 2 ? all.length : null),
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
    void root.api.s.fetchNextPage()
    enabled.set(false)
    await q.invalidateAll()
    enabled.set(true)
    page.resolve('page 1 (call 2)')
    await flush()
    // The page lands, and the catch-up re-fetches both loaded pages.
    expect(calls).toBe(4)
    expect(root.api.s.pages.value).toEqual(['page 0 (call 3)', 'page 1 (call 4)'])
    expect(root.api.s.isStale.value).toBe(false)
    root.dispose()
  })

  test('a prefetch that joins the older fetch resolves with the catch-up', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/join-prefetch',
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
    enabled.set(false)
    await q.invalidateAll()
    const prefetched = q.prefetch()
    first.resolve('old')
    await expect(prefetched).resolves.toBe('fresh')
    expect(calls).toBe(2)
    root.dispose()
  })

  test('an infinite prefetch that joins the older fetch resolves with the catch-up', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'invalidation-outlives/join-prefetch-infinite',
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
    const prefetched = q.prefetch()
    first.resolve('old')
    await expect(prefetched).resolves.toBe('fresh')
    expect(calls).toBe(2)
    root.dispose()
  })

  test('an invalidate() waiting on the older fetch settles with the catch-up', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/join-redirect',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        if (calls === 1) return Promise.resolve('initial')
        return calls === 2 ? first.promise : second.promise
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
    // Subscribed: this invalidation refetches (call 2).
    let settled = false
    void q.invalidateAll().then(() => {
      settled = true
    })
    enabled.set(false)
    // Unsubscribed: this one only marks the entry stale.
    await q.invalidateAll()
    enabled.set(true)
    first.resolve('old')
    await flush()
    expect(calls).toBe(3)
    expect(settled).toBe(false)
    second.resolve('fresh')
    await flush()
    expect(settled).toBe(true)
    expect(root.api.s.data.value).toBe('fresh')
    root.dispose()
  })

  test('no catch-up when nobody holds the entry as the older response lands', async () => {
    const first = deferred<string>()
    let calls = 0
    const q = defineQuery({
      id: 'invalidation-outlives/join-nobody',
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
    enabled.set(false)
    await q.invalidateAll()
    first.resolve('old')
    await flush()
    // Nothing wakes data nobody watches: the next subscriber refetches.
    expect(calls).toBe(1)
    root.dispose()
  })
})
