import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

describe('defineQuery.prefetch — no clients yet', () => {
  test('rejects when no root has touched the query', async () => {
    const q = defineQuery({
      key: () => ['orphan'],
      fetcher: async () => 'never',
    })
    await expect(q.prefetch()).rejects.toThrow(/before any root has subscribed/)
  })
})

describe('defineQuery.prefetch — multiple clients', () => {
  test('rejects an ambiguous prefetch and supports explicit root binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let fetches = 0
      const q = defineQuery({
        key: () => ['multi'],
        fetcher: async () => ++fetches,
        staleTime: 60_000,
      })
      const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
      const r1 = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
      const r2 = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
      await flush()

      await expect(q.prefetch()).rejects.toThrow(/ambiguous/)
      const value = await r1.bindQuery(q).prefetch()
      expect(typeof value).toBe('number')
      r1.dispose()
      r2.dispose()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('defineInfiniteQuery — module-level methods', () => {
  test('invalidate(...args) only refetches the matching key', async () => {
    const calls: number[] = []
    const q = defineInfiniteQuery({
      key: (k: number) => [k],
      fetcher: async ({ pageParam }, k: number) => {
        calls.push(k)
        return `k${k}p${pageParam as number}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const a = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q, () => [1] as const) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const b = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q, () => [2] as const) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.waitFor(() => {
      expect(a.api.x.pages.value).toEqual(['k1p0'])
      expect(b.api.x.pages.value).toEqual(['k2p0'])
    })
    const baseline = calls.length
    await a.bindQuery(q).invalidate(1)
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(baseline))
    expect(calls.filter((k) => k === 1).length).toBe(2)
    expect(calls.filter((k) => k === 2).length).toBe(1)
    a.dispose()
    b.dispose()
  })

  test('invalidateAll refetches every bound key', async () => {
    const calls: number[] = []
    const q = defineInfiniteQuery({
      key: (k: number) => [k],
      fetcher: async (_ctx, k: number) => {
        calls.push(k)
        return `k${k}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const a = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q, () => [1] as const) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const b = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q, () => [2] as const) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.waitFor(() => {
      expect(a.api.x.pages.value).toEqual(['k1'])
      expect(b.api.x.pages.value).toEqual(['k2'])
    })
    const baseline = calls.length
    await Promise.all([a.bindQuery(q).invalidateAll(), b.bindQuery(q).invalidateAll()])
    await vi.waitFor(() => expect(calls.length).toBe(baseline + 2))
    a.dispose()
    b.dispose()
  })

  test('setData applies optimistic pages and rollback restores the previous list', async () => {
    const q = defineInfiniteQuery({
      key: () => ['s'],
      fetcher: async ({ pageParam }) => `p${pageParam as number}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.api.x.pages.value).toEqual(['p0']))

    const snap = q.setData((prev) => [...(prev ?? []), 'p1-optimistic'])
    expect(root.api.x.pages.value).toEqual(['p0', 'p1-optimistic'])
    expect(root.api.x.hasPendingMutations.value).toBe(true)

    snap.rollback()
    expect(root.api.x.pages.value).toEqual(['p0'])
    expect(root.api.x.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('setData finalize clears pending-mutations without reverting', async () => {
    const q = defineInfiniteQuery({
      key: () => ['s2'],
      fetcher: async () => 'p0',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.api.x.pages.value).toEqual(['p0']))

    const snap = q.setData(() => ['committed'])
    expect(root.api.x.hasPendingMutations.value).toBe(true)
    snap.finalize()
    expect(root.api.x.pages.value).toEqual(['committed'])
    expect(root.api.x.hasPendingMutations.value).toBe(false)
    // rollback after finalize is a no-op
    snap.rollback()
    expect(root.api.x.pages.value).toEqual(['committed'])
    root.dispose()
  })

  test('prefetch rejects when no root has subscribed', async () => {
    const q = defineInfiniteQuery({
      key: () => ['none'],
      fetcher: async () => 'page',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    await expect(q.prefetch()).rejects.toThrow(/before any root has subscribed/)
  })

  test('prefetch with multiple roots requires explicit binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const q = defineInfiniteQuery({
        key: () => ['multi'],
        fetcher: async () => 'page',
        initialPageParam: 0,
        getNextPageParam: () => null,
        staleTime: 60_000,
      })
      const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
      const a = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
      const b = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
      await vi.waitFor(() => expect(a.api.x.pages.value).toEqual(['page']))

      await expect(q.prefetch()).rejects.toThrow(/ambiguous/)
      await expect(a.bindQuery(q).prefetch()).resolves.toBe('page')
      a.dispose()
      b.dispose()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('defineQuery.invalidate(...args)', () => {
  test('only invalidates entries that match the provided key', async () => {
    const calls: string[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id: string) => {
        calls.push(id)
        return id.toUpperCase()
      },
    })
    const a = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q, () => ['a'] as const) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const b = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q, () => ['b'] as const) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.waitFor(() => {
      expect(a.api.x.data.value).toBe('A')
      expect(b.api.x.data.value).toBe('B')
    })
    const baseline = calls.length
    await a.bindQuery(q).invalidate('a')
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(baseline))
    expect(calls.filter((k) => k === 'a').length).toBe(2)
    expect(calls.filter((k) => k === 'b').length).toBe(1)
    a.dispose()
    b.dispose()
  })
})

describe('defineQuery({ crossTab: true }) without queryId', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    ;(console.warn as ReturnType<typeof vi.fn>).mockRestore?.()
  })

  test('warns once that cross-tab is disabled without a queryId', () => {
    defineQuery({
      key: () => ['x'],
      fetcher: async () => 1,
      crossTab: true,
    })
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/defineQuery\(\{ crossTab: true \}\) requires a stable `queryId`/),
    )
  })

  test('does not warn when queryId is supplied', () => {
    defineQuery({
      key: () => ['x'],
      fetcher: async () => 1,
      crossTab: true,
      queryId: 'unique-id-1',
    })
    expect(console.warn).not.toHaveBeenCalled()
  })
})
