import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { signal } from '../src/signals'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

describe('subscription.refetch / firstValue when not yet bound', () => {
  test('regular subscription with enabled=false rejects refetch / firstValue', async () => {
    const q = defineQuery({
      key: () => ['unbound'],
      fetcher: async () => 'never',
    })
    const def = defineController((ctx) => ({
      x: ctx.use(q, { key: () => [], enabled: () => false }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    await expect(root.x.refetch()).rejects.toThrow(/no active subscription/)
    await expect(root.x.firstValue()).rejects.toThrow(/no active subscription/)
    root.dispose()
  })

  test('infinite subscription with enabled=false rejects refetch / firstValue and no-ops fetchNextPage', async () => {
    const q = defineInfiniteQuery({
      key: () => ['unbound-inf'],
      fetcher: async () => 'never',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: ctx.use(q, { key: () => [], enabled: () => false }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    await expect(root.x.refetch()).rejects.toThrow(/no active subscription/)
    await expect(root.x.firstValue()).rejects.toThrow(/no active subscription/)
    // fetchNextPage / fetchPreviousPage are silent no-ops without a current entry.
    await expect(root.x.fetchNextPage()).resolves.toBeUndefined()
    await expect(root.x.fetchPreviousPage()).resolves.toBeUndefined()
    root.dispose()
  })
})

describe('enabled gate flip causes detach + attach', () => {
  test('regular: detaches when enabled flips false, re-attaches when true', async () => {
    let fetches = 0
    const enabled = signal(true)
    const q = defineQuery({
      key: () => ['toggleable'],
      fetcher: async () => ++fetches,
    })
    const def = defineController((ctx) => ({
      x: ctx.use(q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.x.data.value).toBe(1))

    enabled.set(false)
    await flush()
    expect(root.x.status.value).toBe('idle')

    enabled.set(true)
    await vi.waitFor(() => expect(root.x.data.value).toBe(2))
    root.dispose()
  })

  test('infinite: detaches when enabled flips false', async () => {
    const enabled = signal(true)
    const q = defineInfiniteQuery({
      key: () => ['toggle-inf'],
      fetcher: async ({ pageParam }: { pageParam: number }) => `p${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: ctx.use(q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))

    enabled.set(false)
    await flush()
    // After detach the subscription's pages signal still returns the default
    // empty array (no current entry).
    expect(root.x.pages.value).toEqual([])
    expect(root.x.status.value).toBe('idle')
    root.dispose()
  })
})

describe('root.suspend / root.resume with an infinite subscription', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('suspend releases the entry; resume rebinds and refetches when stale', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      key: () => ['suspend-inf'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls++
        return `p${pageParam}-${calls}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      // staleTime=0 → resume triggers refetch.
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    root.suspend()
    // While suspended the subscription detaches; current is null.
    root.resume()
    await vi.advanceTimersByTimeAsync(0)
    // resume re-binds and triggers a refetch since data is stale (staleTime=0).
    expect(calls).toBe(2)
    root.dispose()
  })

  test('resume short-circuits when the controller is enabled=false', async () => {
    let calls = 0
    const enabled = signal(false)
    const q = defineInfiniteQuery({
      key: () => ['suspend-disabled'],
      fetcher: async () => {
        calls++
        return 'page'
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: ctx.use(q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(0)
    root.suspend()
    root.resume()
    // Still disabled → resume does nothing.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(0)
    root.dispose()
  })

  test('suspend is a no-op when already suspended; resume is a no-op when not suspended', async () => {
    const q = defineInfiniteQuery({
      key: () => ['idem'],
      fetcher: async () => 'page',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    // Double suspend / double resume should not throw or fetch extra.
    root.suspend()
    root.suspend()
    root.resume()
    root.resume()
    root.dispose()
  })
})
