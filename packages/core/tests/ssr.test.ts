import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMutation, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('dehydrate / hydrate', () => {
  test('dehydrate → hydrate round-trip restores cached data without re-fetching', async () => {
    let fetchCount = 0
    const userQuery = defineQuery({
      id: 'ssr/basic-1',
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string) => {
        fetchCount++
        return { id, name: `User ${id}` }
      },
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      user: createQuery(ctx, userQuery, () => ['u1']),
    }))

    // Server side: fetch + dehydrate.
    const server = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await server.waitForIdle()
    expect(fetchCount).toBe(1)
    const state = server.dehydrate()
    expect(state.version).toBe(1)
    expect(state.entries.length).toBeGreaterThan(0)
    server.dispose()

    // Client side: hydrate before subscribing.
    const client = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    await flush()
    expect(client.api.user.data.value).toEqual({ id: 'u1', name: 'User u1' })
    // staleTime: 60_000 — no refetch.
    expect(fetchCount).toBe(1)
    client.dispose()
  })

  test('hydrated entries respect staleTime: 0 (refetch on subscribe)', async () => {
    let fetchCount = 0
    const q = defineQuery({
      id: 'ssr/basic-2',
      key: () => ['x'],
      fetcher: async () => {
        fetchCount++
        return fetchCount
      },
    })

    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const server = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await server.waitForIdle()
    const state = server.dehydrate()
    server.dispose()

    const client = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    await flush()
    // staleTime is 0 (default), so subscribe sees stale and refetches.
    expect(fetchCount).toBe(2)
    client.dispose()
  })

  test('only successful entries are serialized', async () => {
    const q = defineQuery({
      id: 'ssr/basic-3',
      key: () => ['error'],
      fetcher: async () => {
        throw new Error('nope')
      },
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await root.waitForIdle()
    const state = root.dehydrate()
    expect(state.entries.length).toBe(0)
    root.dispose()
  })
})

describe('waitForIdle', () => {
  test('resolves when no fetches are in flight', async () => {
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await expect(root.waitForIdle()).resolves.toBeUndefined()
    root.dispose()
  })

  test('blocks until a slow fetch completes', async () => {
    let resolveFetch: (() => void) | null = null
    const q = defineQuery({
      id: 'ssr/basic-4',
      key: () => ['slow'],
      fetcher: () =>
        new Promise<number>((r) => {
          resolveFetch = () => r(42)
        }),
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    let resolved = false
    const idlePromise = root.waitForIdle().then(() => {
      resolved = true
    })
    await flush()
    expect(resolved).toBe(false)
    resolveFetch!()
    await idlePromise
    expect(resolved).toBe(true)
    root.dispose()
  })

  test('blocks until in-flight mutations settle', async () => {
    let resolveMutate: (() => void) | null = null
    const def = defineController((ctx) => ({
      save: createMutation(ctx, {
        mutate: () =>
          new Promise<void>((r) => {
            resolveMutate = () => r()
          }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const runPromise = root.api.save.run(undefined)
    await flush()
    let idle = false
    const idlePromise = root.waitForIdle().then(() => {
      idle = true
    })
    await flush()
    expect(idle).toBe(false)
    resolveMutate!()
    await runPromise
    await idlePromise
    expect(idle).toBe(true)
    root.dispose()
  })
})

describe('dehydrated keys survive the JSON trip', () => {
  // `dehydrate` ships raw key args, and the payload reaches the client through
  // JSON. A key JSON rewrites (an `undefined` member, a Date, NaN, an undefined
  // array element) used to hash differently after the trip, so the client never
  // adopted the entry: it mounted `pending` and refetched (§5.4, §15).
  test.each([
    ['an undefined object member', 'member', { a: 1, b: undefined }],
    ['a Date', 'date', new Date('2026-01-02T03:04:05.000Z')],
    ['NaN', 'nan', Number.NaN],
    ['Infinity', 'infinity', Number.POSITIVE_INFINITY],
    ['an undefined array element', 'element', [1, undefined]],
    ['an invalid Date', 'invalid-date', new Date(Number.NaN)],
  ])('a key holding %s is adopted without a refetch', async (_label, slug, part) => {
    let calls = 0
    const q = defineQuery({
      id: `ssr/json-key-${slug}`,
      key: (k: unknown) => [k],
      fetcher: async () => {
        calls += 1
        return 'server data'
      },
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q, () => [part] as [unknown]) }))
    const server = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await server.waitForIdle()
    const state = JSON.parse(JSON.stringify(server.dehydrate()))
    server.dispose()

    const client = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    expect(client.api.x.status.value).toBe('success')
    expect(client.api.x.data.value).toBe('server data')
    await flush()
    expect(calls).toBe(1)
    client.dispose()
  })

  test('a live hydration reaches a bound entry whose key JSON rewrites', async () => {
    const q = defineQuery({
      id: 'ssr/json-key-live',
      key: (filter: { status: string; q: string | undefined }) => [filter],
      fetcher: async () => 'client data',
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({
      x: createQuery(
        ctx,
        q,
        () => [{ status: 'open', q: undefined }] as [{ status: string; q: string | undefined }],
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await root.waitForIdle()
    const payload = JSON.parse(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'ssr/json-key-live',
            key: [{ status: 'open', q: undefined }],
            data: 'streamed',
            lastUpdatedAt: Date.now(),
          },
        ],
      }),
    )
    root.hydrate(payload)
    expect(root.api.x.data.value).toBe('streamed')
    root.dispose()
  })
})

describe('live hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  const row = (id: string, data: unknown, lastUpdatedAt: number, pageParams?: unknown[]) => ({
    version: 1 as const,
    entries: [{ id, key: [], data, lastUpdatedAt, ...(pageParams ? { pageParams } : {}) }],
  })

  test('a row older than the entry data is skipped', async () => {
    const q = defineQuery({
      id: 'ssr/live-older',
      key: () => [],
      fetcher: async () => 'client data',
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.x.lastUpdatedAt.value).toBe(1_000_000)
    vi.setSystemTime(1_005_000)
    root.hydrate(row('ssr/live-older', 'late server row', 999_000))
    expect(root.api.x.data.value).toBe('client data')
    expect(root.api.x.lastUpdatedAt.value).toBe(1_000_000)
    // A newer row is still written through.
    root.hydrate(row('ssr/live-older', 'newer server row', 1_004_000))
    expect(root.api.x.data.value).toBe('newer server row')
    expect(root.api.x.lastUpdatedAt.value).toBe(1_004_000)
    root.dispose()
  })

  test('an infinite entry skips an older row too', async () => {
    const q = defineInfiniteQuery({
      id: 'ssr/live-older-infinite',
      key: () => [],
      fetcher: async () => 'client page',
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_005_000)
    root.hydrate(row('ssr/live-older-infinite', ['late page'], 999_000, [0]))
    expect(root.api.x.pages.value).toEqual(['client page'])
    expect(root.api.x.lastUpdatedAt.value).toBe(1_000_000)
    root.dispose()
  })

  test('a row stamped after an invalidation clears it', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'ssr/live-clears-stale',
      key: () => [],
      fetcher: async () => {
        calls += 1
        return `fetch ${calls}`
      },
      staleTime: 60_000,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        x: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    enabled.set(false)
    vi.setSystemTime(1_001_000)
    await q.invalidate()
    vi.setSystemTime(1_002_000)
    root.hydrate(row('ssr/live-clears-stale', 'streamed', 1_001_500))
    enabled.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(root.api.x.data.value).toBe('streamed')
    expect(root.api.x.isStale.value).toBe(false)
    root.dispose()
  })

  test('a row stamped before an invalidation leaves it in force', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'ssr/live-keeps-stale',
      key: () => [],
      fetcher: async () => {
        calls += 1
        return `fetch ${calls}`
      },
      staleTime: 60_000,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        x: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    enabled.set(false)
    vi.setSystemTime(1_001_000)
    await q.invalidate()
    vi.setSystemTime(1_002_000)
    root.hydrate(row('ssr/live-keeps-stale', 'streamed', 1_000_500))
    enabled.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
    root.dispose()
  })

  test('an infinite entry follows the same rule', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'ssr/live-keeps-stale-infinite',
      key: () => [],
      fetcher: async () => {
        calls += 1
        return `page ${calls}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const enabled = signal(true)
    const root = createRoot(
      defineController((ctx) => ({
        x: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    enabled.set(false)
    vi.setSystemTime(1_001_000)
    await q.invalidate()
    vi.setSystemTime(1_002_000)
    root.hydrate(row('ssr/live-keeps-stale-infinite', ['streamed'], 1_000_500, [0]))
    enabled.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
    root.dispose()
  })
})

describe('a server clock ahead of the client', () => {
  // A payload stamped in the client's future read `isStale` true with
  // `staleTime: 0` yet never fetched, because the subscribe check computed a
  // negative age. A future stamp now counts as "now".
  test('staleTime 0: the hydrated entry refetches on subscribe', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'ssr/future-stamp',
      key: () => [],
      fetcher: async () => {
        calls += 1
        return 'client data'
      },
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const state = {
      version: 1 as const,
      entries: [
        { id: 'ssr/future-stamp', key: [], data: 'server', lastUpdatedAt: Date.now() + 60_000 },
      ],
    }
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    await flush()
    expect(calls).toBe(1)
    expect(root.api.x.lastUpdatedAt.value).toBeLessThanOrEqual(Date.now())
    root.dispose()
  })

  test('staleTime > 0: freshness runs from now, not from the future stamp', () => {
    vi.useFakeTimers()
    try {
      const q = defineQuery({
        id: 'ssr/future-stamp-fresh',
        key: () => [],
        fetcher: async () => 'client data',
        staleTime: 30_000,
      })
      const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
      const state = {
        version: 1 as const,
        entries: [
          {
            id: 'ssr/future-stamp-fresh',
            key: [],
            data: 'server',
            lastUpdatedAt: Date.now() + 60_000,
          },
        ],
      }
      const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
      expect(root.api.x.isStale.value).toBe(false)
      vi.advanceTimersByTime(30_001)
      expect(root.api.x.isStale.value).toBe(true)
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an infinite entry clamps the stamp too', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'ssr/future-stamp-infinite',
      key: () => [],
      fetcher: async () => {
        calls += 1
        return 'client page'
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const state = {
      version: 1 as const,
      entries: [
        {
          id: 'ssr/future-stamp-infinite',
          key: [],
          data: ['server page'],
          pageParams: [0],
          lastUpdatedAt: Date.now() + 60_000,
        },
      ],
    }
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    await flush()
    expect(calls).toBe(1)
    root.dispose()
  })
})
