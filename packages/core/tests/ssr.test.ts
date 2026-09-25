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

  // `dehydrate()` kept only entries at `status: 'success'`. A background
  // refetch reads `'pending'` over the data it replaces, and a failed one
  // `'error'` over the data it kept, so a dehydrate at either moment dropped an
  // entry that held data (§5.3, §15).
  test('an entry holding data mid-refetch is serialized', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      let calls = 0
      const q = defineQuery({
        id: 'ssr/dehydrate-mid-refetch',
        key: () => [],
        fetcher: () => {
          calls += 1
          return calls === 1 ? Promise.resolve('first') : new Promise<string>(() => {})
        },
      })
      const root = createRoot(
        defineController((ctx) => ({ x: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: emptyDeps },
      )
      await vi.advanceTimersByTimeAsync(0)
      vi.setSystemTime(1_005_000)
      void root.api.x.refetch()
      expect(root.api.x.status.value).toBe('pending')
      expect(root.dehydrate().entries).toEqual([
        { id: 'ssr/dehydrate-mid-refetch', key: [], data: 'first', lastUpdatedAt: 1_000_000 },
      ])
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an entry that kept its data through a failed refetch is serialized', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'ssr/dehydrate-after-error',
      key: () => [],
      fetcher: async () => {
        calls += 1
        if (calls > 1) throw new Error('blip')
        return 'first'
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps, onError: () => {} },
    )
    await root.waitForIdle()
    await root.api.x.refetch().catch(() => {})
    expect(root.api.x.status.value).toBe('error')
    expect(root.dehydrate().entries).toMatchObject([
      { id: 'ssr/dehydrate-after-error', data: 'first' },
    ])
    root.dispose()
  })

  test('an infinite entry mid-refetch is serialized with its page params', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'ssr/dehydrate-mid-refetch-infinite',
      key: () => [],
      fetcher: () => {
        calls += 1
        return calls === 1 ? Promise.resolve('page 0') : new Promise<string>(() => {})
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await root.waitForIdle()
    void root.api.x.refetch()
    expect(root.api.x.status.value).toBe('pending')
    expect(root.dehydrate().entries).toMatchObject([
      { id: 'ssr/dehydrate-mid-refetch-infinite', data: ['page 0'], pageParams: [0] },
    ])
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

  // A row that predates an invalidation supersedes the refetch that invalidation
  // started, and leaves the stale mark standing. With a subscriber present,
  // nothing then fetched: the entry sat stale over the row. It now fetches once
  // more, as a `replace` that discards an invalidation's fetch does (§5.7, §6.4).
  test('a row stamped before an invalidation re-runs the fetch it discarded', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'ssr/live-catch-up',
      key: () => [],
      fetcher: () => {
        calls += 1
        // The invalidation's refetch never answers: the row discards it.
        return calls === 2 ? new Promise<string>(() => {}) : Promise.resolve(`fetch ${calls}`)
      },
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_002_000)
    const invalidated = q.invalidate()
    expect(calls).toBe(2)
    root.hydrate(row('ssr/live-catch-up', 'streamed', 1_001_500))
    expect(root.api.x.data.value).toBe('streamed')
    expect(root.api.x.isFetching.value).toBe(true)
    expect(calls).toBe(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.x.data.value).toBe('fetch 3')
    expect(root.api.x.isStale.value).toBe(false)
    // The invalidation settles with the fetch that reconciled it.
    await expect(invalidated).resolves.toBeUndefined()
    root.dispose()
  })

  test('an infinite entry re-runs the discarded refetch too', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'ssr/live-catch-up-infinite',
      key: () => [],
      fetcher: () => {
        calls += 1
        return calls === 2 ? new Promise<string>(() => {}) : Promise.resolve(`page ${calls}`)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_002_000)
    void q.invalidate()
    root.hydrate(row('ssr/live-catch-up-infinite', ['streamed'], 1_001_500, [0]))
    expect(root.api.x.isFetching.value).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(3)
    expect(root.api.x.pages.value).toEqual(['page 3'])
    expect(root.api.x.isStale.value).toBe(false)
    root.dispose()
  })

  test('a row stamped before an invalidation of an unheld entry does not fetch', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'ssr/live-catch-up-unheld',
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
    vi.setSystemTime(1_002_000)
    await q.invalidate()
    root.hydrate(row('ssr/live-catch-up-unheld', 'streamed', 1_001_500))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    root.dispose()
  })

  // Live hydration skipped a row older than `lastUpdatedAt`, which an optimistic
  // `setData` bumps. A guess then outranked the server: the row was dropped, and a
  // rollback restored data older than the row. The comparison now uses the time
  // the server truth was written, by a fetch, a row or a canonical write (§15, §6.4).
  test('an optimistic write does not make a newer server row look old', async () => {
    const q = defineQuery({
      id: 'ssr/live-optimistic-rolled-back',
      key: () => [],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_005_000)
    const snapshot = root.bindQuery(q).setData(() => 'optimistic')
    snapshot.rollback()
    root.hydrate(row('ssr/live-optimistic-rolled-back', 'server row', 1_003_000))
    expect(root.api.x.data.value).toBe('server row')
    expect(root.api.x.lastUpdatedAt.value).toBe(1_003_000)
    root.dispose()
  })

  test('a row during a live optimistic write becomes the rollback baseline', async () => {
    const q = defineQuery({
      id: 'ssr/live-optimistic-live',
      key: () => [],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_005_000)
    const snapshot = root.bindQuery(q).setData(() => 'optimistic')
    root.hydrate(row('ssr/live-optimistic-live', 'server row', 1_003_000))
    snapshot.rollback()
    expect(root.api.x.data.value).toBe('server row')
    root.dispose()
  })

  test('an infinite entry compares against server truth too', async () => {
    const q = defineInfiniteQuery({
      id: 'ssr/live-optimistic-infinite',
      key: () => [],
      fetcher: async () => 'fetched page',
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
    const snapshot = root.bindQuery(q).setData(() => ['optimistic page'])
    root.hydrate(row('ssr/live-optimistic-infinite', ['server page'], 1_003_000, [0]))
    snapshot.rollback()
    expect(root.api.x.pages.value).toEqual(['server page'])
    root.dispose()
  })

  // A row for a key nothing has bound waits in a buffer. The buffer took every
  // row as it came, so an older row overwrote a newer one, and the first bind
  // showed the older data (§15).
  test('a buffered row is not replaced by an older one', async () => {
    const q = defineQuery({
      id: 'ssr/buffer-older',
      key: () => [],
      fetcher: async () => 'client data',
      staleTime: 600_000,
    })
    const enabled = signal(false)
    const root = createRoot(
      defineController((ctx) => ({
        x: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    root.hydrate(row('ssr/buffer-older', 'newer row', 999_000))
    root.hydrate(row('ssr/buffer-older', 'older row', 995_000))
    enabled.set(true)
    expect(root.api.x.data.value).toBe('newer row')
    expect(root.api.x.lastUpdatedAt.value).toBe(999_000)
    root.dispose()
  })

  test('a payload given to createRoot keeps the newest row for a key', async () => {
    const q = defineQuery({
      id: 'ssr/buffer-older-initial',
      key: () => [],
      fetcher: async () => 'client data',
      staleTime: 600_000,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const state = {
      version: 1 as const,
      entries: [
        { id: 'ssr/buffer-older-initial', key: [], data: 'newer row', lastUpdatedAt: 999_000 },
        { id: 'ssr/buffer-older-initial', key: [], data: 'older row', lastUpdatedAt: 995_000 },
      ],
    }
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    expect(root.api.x.data.value).toBe('newer row')
    root.dispose()
  })

  test('a newer row still replaces a buffered one', async () => {
    const q = defineQuery({
      id: 'ssr/buffer-newer',
      key: () => [],
      fetcher: async () => 'client data',
      staleTime: 600_000,
    })
    const enabled = signal(false)
    const root = createRoot(
      defineController((ctx) => ({
        x: createQuery(ctx, q, { enabled: () => enabled.value }),
      })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    root.hydrate(row('ssr/buffer-newer', 'older row', 995_000))
    root.hydrate(row('ssr/buffer-newer', 'newer row', 999_000))
    enabled.set(true)
    expect(root.api.x.data.value).toBe('newer row')
    root.dispose()
  })

  test('a canonical write still outranks an older row', async () => {
    const q = defineQuery({
      id: 'ssr/live-canonical-newer',
      key: () => [],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_005_000)
    root.bindQuery(q).write(() => 'written')
    root.hydrate(row('ssr/live-canonical-newer', 'server row', 1_003_000))
    expect(root.api.x.data.value).toBe('written')
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

// A row whose data is `undefined` ships when its entry reads `'success'`. A
// buffered one gave the new entry `status: 'idle'` with the server's stamp, so
// it read `'pending'` and refetched despite `staleTime`; a live one gave
// `'success'` (§21.9). Both paths give `'success'` now.
describe('a hydrated row with no data', () => {
  test('the buffered path reads success and does not refetch, as the live path does', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'ssr/undefined-row',
      key: () => ['k'],
      fetcher: async (): Promise<string | undefined> => {
        calls += 1
        return undefined
      },
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const row = { id: 'ssr/undefined-row', key: ['k'], data: undefined, lastUpdatedAt: Date.now() }

    const buffered = createRoot(def, {
      queries: queryEngine(),
      deps: emptyDeps,
      hydrate: { version: 1, entries: [row] },
    })
    await flush()
    expect(buffered.api.x.status.value).toBe('success')
    expect(calls).toBe(0)
    await expect(buffered.api.x.firstValue()).resolves.toBeUndefined()
    buffered.dispose()

    const live = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await live.waitForIdle()
    live.hydrate({ version: 1, entries: [{ ...row, lastUpdatedAt: Date.now() }] })
    expect(live.api.x.status.value).toBe('success')
    live.dispose()
  })
})

// `dehydrate()` stamped each row with `lastUpdatedAt`, which an optimistic write
// moves and its rollback leaves. The stamp is when the server said the shipped
// data, and a live guess never ships as server truth (§15, §5.9).
describe('dehydrate ships server truth, stamped by the server clock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function postRoot(id: string) {
    const q = defineQuery({
      id,
      key: () => ['post'],
      fetcher: async () => 'server',
      staleTime: 60_000,
    })
    vi.setSystemTime(1_000)
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    return { root, handle: root.bindQuery(q) }
  }

  test('the reviewer reproduction: a rolled-back guess does not move the stamp', async () => {
    const { root, handle } = postRoot('ssr/stamp-rollback')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(5_000)
    const snap = handle.setData(() => 'guess')
    vi.setSystemTime(6_000)
    snap.rollback()
    expect(root.dehydrate().entries).toEqual([
      { id: 'ssr/stamp-rollback', key: ['post'], data: 'server', lastUpdatedAt: 1_000 },
    ])
    root.dispose()
  })

  test('a live guess ships the data under it, stamped when the server said that', async () => {
    const { root, handle } = postRoot('ssr/stamp-live-guess')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(5_000)
    handle.setData(() => 'guess')
    expect(root.api.x.data.value).toBe('guess')
    expect(root.dehydrate().entries[0]).toMatchObject({ data: 'server', lastUpdatedAt: 1_000 })
    root.dispose()
  })

  test('a canonical write under a live guess ships, stamped when it was written', async () => {
    const { root, handle } = postRoot('ssr/stamp-live-write')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(5_000)
    handle.setData((p) => `${p}+guess`)
    vi.setSystemTime(7_000)
    handle.write((p) => `${p}+pushed`)
    expect(root.api.x.data.value).toBe('server+guess+pushed')
    expect(root.dehydrate().entries[0]).toMatchObject({
      data: 'server+pushed',
      lastUpdatedAt: 7_000,
    })
    root.dispose()
  })

  test('a committed guess ships with the last server stamp, which a commit does not move', async () => {
    const { root, handle } = postRoot('ssr/stamp-commit')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(5_000)
    handle.setData(() => 'guess').finalize()
    expect(root.dehydrate().entries[0]).toMatchObject({ data: 'guess', lastUpdatedAt: 1_000 })
    root.dispose()
  })

  test('a rolled-back guess on an entry the server never answered ships nothing', () => {
    const q = defineQuery({
      id: 'ssr/stamp-never-answered',
      key: () => ['post'],
      fetcher: async () => 'server',
    })
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: emptyDeps },
    )
    root
      .bindQuery(q)
      .setData(() => 'guess')
      .rollback()
    expect(root.dehydrate().entries).toEqual([])
    root.dispose()
  })

  test('an infinite entry ships the pages under a live guess', async () => {
    const q = defineInfiniteQuery({
      id: 'ssr/stamp-infinite',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => `p${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    vi.setSystemTime(1_000)
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(5_000)
    root.bindQuery(q).setData((pages) => [...(pages ?? []), 'guess'])
    expect(root.dehydrate().entries[0]).toMatchObject({
      data: ['p0'],
      pageParams: [0],
      lastUpdatedAt: 1_000,
    })
    root.dispose()
  })
})
