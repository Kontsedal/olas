import {
  bindQuery,
  type Ctx,
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { persistQueryCachePlugin, restoreQueryCache, type StorageAdapter } from '../src'

const KEY = 'olas/query-cache'

function memory(opts: { async?: boolean } = {}): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>()
  const wrap = <T>(v: T): T | Promise<T> => (opts.async ? Promise.resolve(v) : v)
  return {
    store,
    get: (k) => wrap(store.get(k) ?? null),
    set: (k, v) => {
      store.set(k, v)
      return opts.async ? Promise.resolve() : undefined
    },
    delete: (k) => {
      store.delete(k)
      return opts.async ? Promise.resolve() : undefined
    },
  }
}

const stored = (storage: { store: Map<string, string> }) =>
  JSON.parse(storage.store.get(KEY) ?? 'null') as {
    v: number
    buster: string
    entries: Array<{ id: string; data: unknown; pageParams?: unknown[]; lastUpdatedAt: number }>
  } | null

describe('persistQueryCachePlugin — write-through', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('persists opted-in queries after the throttle; skips the rest and optimistic writes', async () => {
    const storage = memory()
    const kept = defineQuery({
      id: 'qc/kept',
      key: () => [],
      fetcher: async () => ({ name: 'Ada' }),
      meta: { persist: true },
    })
    const skipped = defineQuery({ id: 'qc/skipped', key: () => [], fetcher: async () => 1 })
    const root = createRoot(
      defineController((ctx) => ({
        kept: createQuery(ctx, kept),
        skipped: createQuery(ctx, skipped),
      })),
      { queries: queryEngine(), deps: {}, plugins: [persistQueryCachePlugin({ storage })] },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.store.has(KEY)).toBe(false) // throttled
    await vi.advanceTimersByTimeAsync(1000)
    expect(stored(storage)?.entries.map((e) => [e.id, e.data])).toEqual([
      ['qc/kept', { name: 'Ada' }],
    ])

    // An optimistic write is a guess: storage keeps the canonical value.
    root.bindQuery(kept).setData(() => ({ name: 'guess' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(stored(storage)?.entries[0]?.data).toEqual({ name: 'Ada' })
    root.dispose()
  })

  test('dispose flushes a pending write', async () => {
    const storage = memory()
    const q = defineQuery({
      id: 'qc/flush',
      key: () => [],
      fetcher: async () => 'v',
      meta: { persist: true },
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, plugins: [persistQueryCachePlugin({ storage })] },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.store.has(KEY)).toBe(false)
    root.dispose()
    expect(stored(storage)?.entries[0]?.data).toBe('v')
  })
})

describe('persistQueryCachePlugin — restore', () => {
  test('a reload starts from the stored entry, with no fetch while it is fresh', async () => {
    const storage = memory()
    const fetcher = vi.fn(async () => 'server')
    const q = defineQuery({
      id: 'qc/reload',
      key: () => [],
      fetcher,
      staleTime: 60_000,
      meta: { persist: true },
    })
    const plugins = () => [persistQueryCachePlugin({ storage, throttleMs: 0 })]
    const first = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: plugins(),
      },
    )
    await first.waitForIdle()
    first.dispose()
    expect(fetcher).toHaveBeenCalledTimes(1)

    const second = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: plugins(),
      },
    )
    expect(second.api.q.data.value).toBe('server') // there on the first read
    await second.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    second.dispose()
  })

  test('a different buster, or an entry past maxAgeMs, is not restored', async () => {
    const storage = memory()
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: 'v1',
        entries: [
          { id: 'qc/old', key: [], data: 'old', lastUpdatedAt: Date.now() - 10_000 },
          { id: 'qc/new', key: [], data: 'new', lastUpdatedAt: Date.now() },
        ],
      }),
    )
    const mk = (id: string) =>
      defineQuery({ id, key: () => [], fetcher: async () => 'fetched', staleTime: 60_000 })
    const oldQ = mk('qc/old')
    const newQ = mk('qc/new')
    const def = defineController((ctx) => ({
      o: createQuery(ctx, oldQ),
      n: createQuery(ctx, newQ),
    }))

    const wrongBuster = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [persistQueryCachePlugin({ storage, buster: 'v2', throttleMs: 0 })],
    })
    expect(wrongBuster.api.n.data.value).toBeUndefined()
    wrongBuster.dispose()

    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: 'v1',
        entries: [
          { id: 'qc/old', key: [], data: 'old', lastUpdatedAt: Date.now() - 10_000 },
          { id: 'qc/new', key: [], data: 'new', lastUpdatedAt: Date.now() },
        ],
      }),
    )
    const aged = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [persistQueryCachePlugin({ storage, buster: 'v1', maxAgeMs: 5_000, throttleMs: 0 })],
    })
    expect(aged.api.n.data.value).toBe('new')
    expect(aged.api.o.data.value).toBeUndefined() // past maxAgeMs
    aged.dispose()
  })

  test('async storage: fills only unbound entries, never one a fetch is filling', async () => {
    const storage = memory({ async: true })
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [
          { id: 'qc/bound', key: [], data: 'stale', lastUpdatedAt: Date.now() },
          { id: 'qc/later', key: [], data: 'restored', lastUpdatedAt: Date.now() },
        ],
      }),
    )
    const bound = defineQuery({ id: 'qc/bound', key: () => [], fetcher: async () => 'fresh' })
    const later = defineQuery({
      id: 'qc/later',
      key: () => [],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({
        bound: createQuery(ctx, bound),
        open: () =>
          ctx.attach(
            defineController((c) => ({ later: createQuery(c, later) })),
            undefined,
          ),
      })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )
    await root.waitForIdle() // waits for the tracked restore too
    expect(root.api.bound.data.value).toBe('fresh') // the restore did not overwrite it
    const child = root.api.open()
    expect(child.api.later.data.value).toBe('restored') // unbound at restore time: filled
    root.dispose()
  })

  test('corrupt storage reports a restore error and the app still works', async () => {
    const storage = memory()
    storage.store.set(KEY, '{not json')
    const onError = vi.fn()
    const q = defineQuery({ id: 'qc/corrupt', key: () => [], fetcher: async () => 'ok' })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, onError })],
      },
    )
    await root.waitForIdle()
    expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError), 'restore')
    expect(root.api.q.data.value).toBe('ok')
    root.dispose()
  })

  test('restoreQueryCache reads ahead of createRoot for async storage', async () => {
    const storage = memory({ async: true })
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [{ id: 'qc/ahead', key: [], data: 7, lastUpdatedAt: Date.now() }],
      }),
    )
    const hydrate = await restoreQueryCache({ storage })
    const q = defineQuery({
      id: 'qc/ahead',
      key: () => [],
      fetcher: async () => 0,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        hydrate,
        plugins: [persistQueryCachePlugin({ storage, restore: false })],
      },
    )
    expect(root.api.q.data.value).toBe(7)
    root.dispose()
    expect(await restoreQueryCache({ storage: memory() })).toBeUndefined()
  })
})

describe('persistQueryCachePlugin — restore: false keeps what this session never bound', () => {
  // Session 1 visits page A. Session 2 restores ahead of `createRoot`, as the
  // docs show, and visits only page B. Core buffers A's hydrated entry and
  // tells plugins about it only when something binds it, so the plugin must
  // learn about A from storage, or its first flush writes B alone.
  const pages = () => ({
    a: defineQuery({
      id: 'qc/page-a',
      key: () => [],
      fetcher: async () => 'A',
      staleTime: 60_000,
      meta: { persist: true },
    }),
    b: defineQuery({
      id: 'qc/page-b',
      key: () => [],
      fetcher: async () => 'B',
      staleTime: 60_000,
      meta: { persist: true },
    }),
  })

  test.each([
    ['sync', false],
    ['async', true],
  ])('%s storage: page A survives a session that visits only page B', async (_label, async) => {
    const storage = memory({ async })
    const { a, b } = pages()
    const first = createRoot(
      defineController((ctx) => ({ a: createQuery(ctx, a) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )
    await first.waitForIdle()
    first.dispose()
    expect(stored(storage)?.entries.map((e) => e.id)).toEqual(['qc/page-a'])

    const hydrate = await restoreQueryCache({ storage })
    const second = createRoot(
      defineController((ctx) => ({ b: createQuery(ctx, b) })),
      {
        queries: queryEngine(),
        deps: {},
        hydrate,
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0, restore: false })],
      },
    )
    await second.waitForIdle()
    second.dispose()
    expect(
      stored(storage)
        ?.entries.map((e) => [e.id, e.data])
        .sort(),
    ).toEqual([
      ['qc/page-a', 'A'],
      ['qc/page-b', 'B'],
    ])
  })

  test('async storage: a write before the read lands waits for it, then keeps both', async () => {
    const store = new Map<string, string>()
    store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [{ id: 'qc/page-a', key: [], data: 'A', lastUpdatedAt: Date.now() }],
      }),
    )
    let finishRead: () => void = () => {}
    const storage: StorageAdapter = {
      get: (k) =>
        new Promise<string | null>((resolve) => {
          finishRead = () => resolve(store.get(k) ?? null)
        }),
      set: (k, v) => {
        store.set(k, v)
      },
      delete: (k) => {
        store.delete(k)
      },
    }
    const { b } = pages()
    const root = createRoot(
      defineController((ctx) => ({ b: createQuery(ctx, b) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0, restore: false })],
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(root.api.b.data.value).toBe('B')
    // Storage has not answered: writing now would drop page A.
    expect(JSON.parse(store.get(KEY) as string).entries.map((e: { id: string }) => e.id)).toEqual([
      'qc/page-a',
    ])
    finishRead()
    await root.waitForIdle()
    const written = JSON.parse(store.get(KEY) as string) as { entries: Array<{ id: string }> }
    expect(written.entries.map((e) => e.id).sort()).toEqual(['qc/page-a', 'qc/page-b'])
    root.dispose()
  })
})

describe('persistQueryCachePlugin — a read that fails', () => {
  // Storage holds page A. This session's first read fails, as WebKit's
  // IndexedDB does when its connection is lost, and it visits only page B.
  const pageA = () =>
    JSON.stringify({
      v: 1,
      buster: '',
      entries: [{ id: 'qc/page-a', key: [], data: 'A', lastUpdatedAt: Date.now() }],
    })
  const pageB = () =>
    defineQuery({
      id: 'qc/page-b',
      key: () => [],
      fetcher: async () => 'B',
      staleTime: 60_000,
      meta: { persist: true },
    })
  const flaky = (async: boolean) => {
    const store = new Map([[KEY, pageA()]])
    const failure = new Error('Connection to Indexed Database server lost')
    let reads = 0
    const storage: StorageAdapter = {
      get: (k) => {
        reads += 1
        if (reads === 1) {
          if (async) return Promise.reject(failure)
          throw failure
        }
        const value = store.get(k) ?? null
        return async ? Promise.resolve(value) : value
      },
      set: (k, v) => {
        store.set(k, v)
      },
      delete: (k) => {
        store.delete(k)
      },
    }
    const ids = () =>
      (JSON.parse(store.get(KEY) as string) as { entries: Array<{ id: string }> }).entries
        .map((e) => e.id)
        .sort()
    return { storage, failure, ids }
  }
  const mount = (storage: StorageAdapter, onError: () => void) => {
    const b = pageB()
    return createRoot(
      defineController((ctx) => ({ b: createQuery(ctx, b) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0, restore: false, onError })],
      },
    )
  }

  test('async storage: the write waits, and the next flush reads storage again', async () => {
    const { storage, failure, ids } = flaky(true)
    const onError = vi.fn()
    const root = mount(storage, onError)
    await root.waitForIdle()
    expect(root.api.b.data.value).toBe('B')
    expect(onError).toHaveBeenCalledWith(failure, 'restore')
    // Nothing was read, so nothing was written: page A is still there.
    expect(ids()).toEqual(['qc/page-a'])
    // Dispose flushes the held write, and reads first.
    root.dispose()
    await new Promise((r) => setTimeout(r, 0))
    expect(ids()).toEqual(['qc/page-a', 'qc/page-b'])
  })

  test('sync storage: a flush whose read throws writes nothing, and the next flush reads again', async () => {
    const { storage, failure, ids } = flaky(false)
    const onError = vi.fn()
    const root = mount(storage, onError)
    await root.waitForIdle()
    expect(onError).toHaveBeenCalledWith(failure, 'restore')
    expect(ids()).toEqual(['qc/page-a'])
    await root.api.b.refetch()
    expect(ids()).toEqual(['qc/page-a', 'qc/page-b'])
    root.dispose()
  })
})

describe('persistQueryCachePlugin — two tabs on one storage', () => {
  // Two tabs of one app write one storage key. A flush that wrote this tab's
  // own map over the key deleted every entry the other tab had stored since,
  // and wrote this tab's older copy of an entry over the other tab's fresher one.
  const two = (prefix: string, opts: { staleTime?: number; gcTime?: number } = {}) => {
    const served = new Map<string, number>()
    const mk = (id: string) =>
      defineQuery({
        id: `${prefix}/${id}`,
        key: () => [],
        fetcher: async () => {
          const n = (served.get(id) ?? 0) + 1
          served.set(id, n)
          return `${id}${n}`
        },
        staleTime: opts.staleTime ?? 60_000,
        ...(opts.gcTime !== undefined ? { gcTime: opts.gcTime } : {}),
        meta: { persist: true },
      })
    return {
      a: mk('a'),
      b: mk('b'),
      x: mk('x'),
      id: (name: 'a' | 'b' | 'x') => `${prefix}/${name}`,
    }
  }
  const tab = <T>(storage: StorageAdapter, api: (ctx: Ctx) => T) =>
    createRoot(defineController(api), {
      queries: queryEngine(),
      deps: {},
      plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
    })
  const rows = (storage: { store: Map<string, string> }) =>
    stored(storage)?.entries.map((e) => [e.id, e.data])

  test.each([
    ['sync', false],
    ['async', true],
  ])('%s storage: a flush keeps the entries another tab wrote', async (_label, async) => {
    const storage = memory({ async })
    const { a, b, id } = two(`qc/tabs-${_label}`)
    const tabB = tab(storage, (ctx) => ({ b: createQuery(ctx, b) }))
    await tabB.waitForIdle()
    const tabA = tab(storage, (ctx) => ({ a: createQuery(ctx, a) }))
    await tabA.waitForIdle()
    expect(rows(storage)).toEqual([
      [id('b'), 'b1'],
      [id('a'), 'a1'],
    ])

    await tabB.api.b.refetch()
    await tabB.waitForIdle()
    expect(rows(storage)).toEqual([
      [id('b'), 'b2'],
      [id('a'), 'a1'],
    ])
    tabA.dispose()
    tabB.dispose()
  })

  test("an older copy this tab restored never lands over another tab's fresher one", async () => {
    const storage = memory()
    const { a, x, id } = two('qc/tabs-older')
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [{ id: id('x'), key: [], data: 'stored', lastUpdatedAt: Date.now() - 10_000 }],
      }),
    )
    // Both tabs restore the stored copy, and neither refetches it: it is fresh.
    const tabB = tab(storage, (ctx) => ({ x: createQuery(ctx, x), a: createQuery(ctx, a) }))
    const tabA = tab(storage, (ctx) => ({ x: createQuery(ctx, x) }))
    await tabB.waitForIdle()
    await tabA.waitForIdle()
    expect(tabB.api.x.data.value).toBe('stored')

    await tabA.api.x.refetch()
    await tabA.waitForIdle()
    // Tab B flushes for an unrelated entry. It still holds the old copy.
    await tabB.api.a.refetch()
    await tabB.waitForIdle()
    expect(tabB.api.x.data.value).toBe('stored')
    expect(rows(storage)).toEqual([
      [id('x'), 'x1'],
      [id('a'), 'a2'],
    ])
    tabA.dispose()
    tabB.dispose()
  })

  test("an entry this tab collects leaves storage, but another tab's newer copy stays", async () => {
    const storage = memory()
    const { x, id } = two('qc/tabs-gc', { gcTime: 0 })
    const open = (ctx: Ctx) => ({
      open: () =>
        ctx.attach(
          defineController((c) => ({ x: createQuery(c, x) })),
          undefined,
        ),
    })
    const tabB = tab(storage, open)
    const tabA = tab(storage, open)
    const inB = tabB.api.open()
    await tabB.waitForIdle()
    await new Promise((r) => setTimeout(r, 2)) // tab A's copy is the newer one
    const inA = tabA.api.open()
    await tabA.waitForIdle()
    expect(rows(storage)).toEqual([[id('x'), 'x2']])

    inB.dispose() // gcTime 0: tab B collects its older copy at once
    expect(rows(storage)).toEqual([[id('x'), 'x2']])
    inA.dispose() // tab A collects the copy storage holds
    expect(rows(storage)).toEqual([])
    tabA.dispose()
    tabB.dispose()
  })
})

describe('persistQueryCachePlugin — server truth under optimistic writes', () => {
  const post = (id: string) =>
    defineQuery({
      id,
      key: () => [],
      fetcher: async () => ({ title: 'Hello', likes: 0 }),
      staleTime: 60_000,
      meta: { persist: true },
    })
  const mount = (q: ReturnType<typeof post>, storage: StorageAdapter) =>
    createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q), qs: bindQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )

  // A canonical write made while a guess is live carries the guess in `data`.
  // The plugin stored it, and the rollback that corrected it is a source the
  // plugin skips, so a reload brought the failed guess back.
  test('a write under a live guess stores the data beneath it, and a reload has no guess', async () => {
    const storage = memory()
    const q = post('qc/opt-write')
    const root = mount(q, storage)
    await root.waitForIdle()
    const like = root.api.qs.setData((p) => ({ ...p!, likes: 1 }))
    root.api.qs.write((p) => ({ ...p!, title: 'Renamed' }))
    expect(stored(storage)?.entries[0]?.data).toEqual({ title: 'Renamed', likes: 0 })
    like.rollback()
    expect(stored(storage)?.entries[0]?.data).toEqual({ title: 'Renamed', likes: 0 })
    root.dispose()

    const reload = mount(q, storage)
    expect(reload.api.q.data.peek()).toEqual({ title: 'Renamed', likes: 0 })
    reload.dispose()
  })

  // A commit keeps the stamp of the fetch before it, so its row ties with the
  // row that fetch stored. The tie goes to this session, or the commit would
  // never replace the row it changed.
  test('a commit is stored over the row its fetch stored, with the fetch stamp', async () => {
    const storage = memory()
    const q = post('qc/opt-commit')
    const root = mount(q, storage)
    await root.waitForIdle()
    const fetchedAt = stored(storage)?.entries[0]?.lastUpdatedAt
    const like = root.api.qs.setData((p) => ({ ...p!, likes: 1 }))
    expect(stored(storage)?.entries[0]?.data).toEqual({ title: 'Hello', likes: 0 })
    like.finalize()
    expect(stored(storage)?.entries[0]).toMatchObject({
      data: { title: 'Hello', likes: 1 },
      lastUpdatedAt: fetchedAt,
    })
    root.dispose()
  })

  // An optimistic create into an entry nothing fetched: its commit has no
  // server time to age it by, so `maxAgeMs` could not bound it. It is not stored.
  test('a commit the server never answered for is not stored', () => {
    const storage = memory()
    const q = post('qc/opt-create')
    const root = createRoot(
      defineController((ctx) => ({ qs: bindQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )
    root.api.qs.setData(() => ({ title: 'New', likes: 0 })).finalize()
    expect(storage.store.has(KEY)).toBe(false)
    root.dispose()
  })

  test('an infinite page fetched under a live guess is stored without the guess', async () => {
    const storage = memory()
    const feed = defineInfiniteQuery({
      id: 'qc/opt-feed',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => [`p${pageParam}`],
      initialPageParam: 0,
      getNextPageParam: (_last: string[], all: string[][]) => (all.length < 3 ? all.length : null),
      staleTime: 60_000,
      meta: { persist: true },
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed), fs: bindQuery(ctx, feed) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )
    await root.waitForIdle()
    const guess = root.api.fs.setData((pages = []) => [
      ['draft', ...(pages[0] ?? [])],
      ...pages.slice(1),
    ])
    await root.api.f.fetchNextPage()
    const row = stored(storage)?.entries[0]
    expect(row).toBeDefined()
    expect(JSON.stringify(row!.data)).not.toContain('draft')
    expect(row!.pageParams).toHaveLength((row!.data as unknown[]).length)
    guess.rollback()
    root.dispose()
  })
})

describe('persistQueryCachePlugin — a query that opted out since it was stored', () => {
  test('its stored entries are not written back once the root knows the query', async () => {
    const storage = memory({ async: true })
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [
          { id: 'qc/opted-out', key: [], data: 'stale', lastUpdatedAt: Date.now() },
          { id: 'qc/never-used', key: [], data: 'kept', lastUpdatedAt: Date.now() },
        ],
      }),
    )
    const optedOut = defineQuery({ id: 'qc/opted-out', key: () => [], fetcher: async () => 'x' })
    const kept = defineQuery({
      id: 'qc/kept-too',
      key: () => [],
      fetcher: async () => 'k',
      meta: { persist: true },
    })
    const root = createRoot(
      defineController((ctx) => ({ o: createQuery(ctx, optedOut), k: createQuery(ctx, kept) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0, restore: false })],
      },
    )
    await root.waitForIdle()
    // A query this session never used may still opt in: its entry stays.
    expect(
      stored(storage)
        ?.entries.map((e) => e.id)
        .sort(),
    ).toEqual(['qc/kept-too', 'qc/never-used'])
    root.dispose()
  })
})

describe('persistQueryCachePlugin — infinite queries and gc', () => {
  test('an infinite query persists its pages with their params and restores them', async () => {
    const storage = memory()
    const feed = () =>
      defineInfiniteQuery({
        id: 'qc/feed',
        key: () => [],
        fetcher: async ({ pageParam }: { pageParam: number }) => ({ n: pageParam }),
        initialPageParam: 0,
        getNextPageParam: (p: { n: number }) => (p.n < 3 ? p.n + 1 : null),
        staleTime: 60_000,
        meta: { persist: true },
      })
    const plugin = () => [persistQueryCachePlugin({ storage, throttleMs: 0 })]
    const q1 = feed()
    const first = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, q1) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: plugin(),
      },
    )
    await first.waitForIdle()
    await first.api.f.fetchNextPage()
    first.dispose()
    expect(stored(storage)?.entries[0]?.pageParams).toEqual([0, 1])

    const q2 = feed()
    const second = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, q2) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: plugin(),
      },
    )
    expect(second.api.f.pages.value).toEqual([{ n: 0 }, { n: 1 }])
    second.dispose()
  })

  test('an entry the cache garbage-collects leaves storage too', async () => {
    const storage = memory()
    const q = defineQuery({
      id: 'qc/gc',
      key: () => [],
      fetcher: async () => 'x',
      gcTime: 0,
      meta: { persist: true },
    })
    const root = createRoot(
      defineController((ctx) => ({
        open: () =>
          ctx.attach(
            defineController((c) => ({ q: createQuery(c, q) })),
            undefined,
          ),
      })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )
    const child = root.api.open()
    await root.waitForIdle()
    expect(stored(storage)?.entries).toHaveLength(1)
    child.dispose() // gcTime 0: the entry is dropped at once
    expect(stored(storage)?.entries).toHaveLength(0)
    root.dispose()
  })
})
