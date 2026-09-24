import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createQuery, QueryDisabledError } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

describe('a disabled subscription: isEnabled, refetch, firstValue', () => {
  test('regular: isEnabled is false, refetch rejects QueryDisabledError, firstValue waits', async () => {
    const enabled = signal(false)
    const q = defineQuery({
      id: 'use-edges/16',
      key: () => ['unbound'],
      fetcher: async () => 'loaded',
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.x.isEnabled.value).toBe(false)
    const refetch = root.api.x.refetch()
    await expect(refetch).rejects.toBeInstanceOf(QueryDisabledError)
    await expect(refetch).rejects.toMatchObject({ queryId: 'use-edges/16' })

    // firstValue does not reject while disabled: it resolves once the
    // subscription is enabled and the entry loads.
    let settled: unknown = 'pending'
    const first = root.api.x.firstValue().then((v) => {
      settled = v
    })
    await flush()
    expect(settled).toBe('pending')
    // Asked again while pending, it is the same promise, so a suspended render
    // that re-throws does not mint a new one.
    expect(root.api.x.firstValue()).toBe(root.api.x.firstValue())
    enabled.set(true)
    expect(root.api.x.isEnabled.value).toBe(true)
    await first
    expect(settled).toBe('loaded')
    root.dispose()
  })

  test('regular: a firstValue waiting on a disabled subscription rejects on dispose', async () => {
    const q = defineQuery({
      id: 'use-edges/disposed-wait',
      key: () => [],
      fetcher: async () => 'never',
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { enabled: () => false }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const waiting = root.api.x.firstValue()
    root.dispose()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('infinite: the same contract, and fetchNextPage stays a silent no-op', async () => {
    const enabled = signal(false)
    const q = defineInfiniteQuery({
      id: 'use-edges/31',
      key: () => ['unbound-inf'],
      fetcher: async () => 'page',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.x.isEnabled.value).toBe(false)
    await expect(root.api.x.refetch()).rejects.toBeInstanceOf(QueryDisabledError)
    // fetchNextPage / fetchPreviousPage are silent no-ops without a current entry.
    await expect(root.api.x.fetchNextPage()).resolves.toBeUndefined()
    await expect(root.api.x.fetchPreviousPage()).resolves.toBeUndefined()
    const first = root.api.x.firstValue()
    enabled.set(true)
    await expect(first).resolves.toEqual(['page'])
    root.dispose()
  })
})

describe('enabled gate flip causes detach + attach', () => {
  test('regular: detaches when enabled flips false, re-attaches when true', async () => {
    let fetches = 0
    const enabled = signal(true)
    const q = defineQuery({
      id: 'use-edges/55',
      key: () => ['toggleable'],
      fetcher: async () => ++fetches,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(1))

    enabled.set(false)
    await flush()
    expect(root.api.x.status.value).toBe('idle')

    enabled.set(true)
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(2))
    root.dispose()
  })

  test('infinite: detaches when enabled flips false', async () => {
    const enabled = signal(true)
    const q = defineInfiniteQuery({
      id: 'use-edges/76',
      key: () => ['toggle-inf'],
      fetcher: async ({ pageParam }: { pageParam: number }) => `p${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.x.pages.value).toEqual(['p0']))

    enabled.set(false)
    await flush()
    // After detach the subscription's pages signal still returns the default
    // empty array (no current entry).
    expect(root.api.x.pages.value).toEqual([])
    expect(root.api.x.status.value).toBe('idle')
    root.dispose()
  })
})

describe('root.suspend / root.resume with an infinite subscription', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('suspend releases the entry; resume rebinds and refetches when stale', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'use-edges/104',
      key: () => ['suspend-inf'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls++
        return `p${pageParam}-${calls}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      // staleTime=0 → resume triggers refetch.
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
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
      id: 'use-edges/131',
      key: () => ['suspend-disabled'],
      fetcher: async () => {
        calls++
        return 'page'
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
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
      id: 'use-edges/155',
      key: () => ['idem'],
      fetcher: async () => 'page',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    // Double suspend / double resume should not throw or fetch extra.
    root.suspend()
    root.suspend()
    root.resume()
    root.resume()
    root.dispose()
  })
})
