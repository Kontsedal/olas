// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createCache, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { type ReadSignal, signal } from '../src/signals'
import { createTestController } from '../src/testing'

const emptyDeps = {}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('queryEngine({ defaults }) — staleTime (§5.9)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('root staleTime reaches the entry — freshness is timer-driven', async () => {
    const q = defineQuery({
      id: 'query-default-options/23',
      key: () => ['s'],
      fetcher: async () => 1,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createTestController(def, {
      deps: emptyDeps,
      props: undefined,
      queries: queryEngine({ defaults: { staleTime: 60_000 } }),
    })

    await vi.advanceTimersByTimeAsync(0)
    // Without the root default this query is staleTime: 0 → stale immediately.
    expect(root.api.x.isStale.value).toBe(false)

    await vi.advanceTimersByTimeAsync(59_000)
    expect(root.api.x.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(root.api.x.isStale.value).toBe(true)
    root.dispose()
  })

  test('root staleTime gates a focus refetch until the data goes stale', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-default-options/44',
      key: () => ['s-focus'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { staleTime: 60_000 } }),
      deps: emptyDeps,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    // Fresh → the focus handler short-circuits on `isStaleNow()`.
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    // Past staleTime → the same event now refetches.
    await vi.advanceTimersByTimeAsync(61_000)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)
    root.dispose()
  })

  test('per-query staleTime overrides the root default', async () => {
    const q = defineQuery({
      id: 'query-default-options/72',
      key: () => ['s-override'],
      fetcher: async () => 1,
      staleTime: 0,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createTestController(def, {
      deps: emptyDeps,
      props: undefined,
      queries: queryEngine({ defaults: { staleTime: 60_000 } }),
    })

    await vi.advanceTimersByTimeAsync(0)
    // spec.staleTime: 0 wins over the root's 60s → stale right away.
    expect(root.api.x.isStale.value).toBe(true)
    root.dispose()
  })

  test('no engine defaults keeps the built-in staleTime: 0', async () => {
    const q = defineQuery({
      id: 'query-default-options/91',
      key: () => ['s-builtin'],
      fetcher: async () => 1,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.x.isStale.value).toBe(true)
    root.dispose()
  })
})

describe('queryEngine({ defaults }) — retry (§5.9)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('root retry + retryDelay apply to a query that omits them', async () => {
    let attempts = 0
    const q = defineQuery({
      id: 'query-default-options/106',
      key: () => ['r'],
      fetcher: async () => {
        attempts++
        throw new Error(`fail-${attempts}`)
      },
    })
    const def = defineController((ctx) => ({ r: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { retry: 2, retryDelay: 10 } }),
      deps: emptyDeps,
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(attempts).toBe(3) // initial + 2 retries
    expect(root.api.r.status.value).toBe('error')
    expect((root.api.r.error.value as Error).message).toBe('fail-3')
    root.dispose()
  })

  test('per-query retry: 0 overrides a root default that would retry', async () => {
    let attempts = 0
    const q = defineQuery({
      id: 'query-default-options/131',
      key: () => ['r-override'],
      fetcher: async () => {
        attempts++
        throw new Error('nope')
      },
      retry: 0,
    })
    const def = defineController((ctx) => ({ r: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { retry: 5, retryDelay: 10 } }),
      deps: emptyDeps,
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(attempts).toBe(1)
    expect(root.api.r.status.value).toBe('error')
    root.dispose()
  })
})

describe('queryEngine({ defaults }) — gcTime + keepPreviousData', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // gcTime is a property of the entry inside ONE client, so the subscriber has
  // to come and go within a single root — two `createTestController` calls
  // would be two clients and two caches, and would "pass" for the wrong reason.
  function openCloseRoot(q: ReturnType<typeof defineQuery<[], number>>) {
    const sub = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    return defineController((ctx) => {
      let handle: readonly [{ x: unknown }, () => void] | null = null
      return {
        open: () => {
          handle = ctx.session(sub, undefined)
        },
        close: () => {
          handle?.[1]()
          handle = null
        },
      }
    })
  }

  test('root gcTime drops the entry after the last release', async () => {
    let fetchCount = 0
    const q = defineQuery({
      id: 'query-default-options/179',
      key: () => [],
      fetcher: async () => ++fetchCount,
    })
    const root = createRoot(openCloseRoot(q), {
      queries: queryEngine({ defaults: { gcTime: 100, staleTime: 60_000 } }),
      deps: emptyDeps,
    })

    root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount).toBe(1)

    root.api.close()
    await vi.advanceTimersByTimeAsync(200) // past the root-wide gcTime
    root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount).toBe(2)
    root.dispose()
  })

  test('control: a long root gcTime keeps the entry across the same gap', async () => {
    let fetchCount = 0
    const q = defineQuery({
      id: 'query-default-options/201',
      key: () => [],
      fetcher: async () => ++fetchCount,
    })
    const root = createRoot(openCloseRoot(q), {
      queries: queryEngine({ defaults: { gcTime: 60_000, staleTime: 60_000 } }),
      deps: emptyDeps,
    })

    root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount).toBe(1)

    root.api.close()
    await vi.advanceTimersByTimeAsync(200)
    root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount).toBe(1) // entry survived; still fresh
    root.dispose()
  })

  test('root keepPreviousData holds prior data across a key change', async () => {
    const q = defineQuery({
      id: 'query-default-options/221',
      key: (id: string) => [id],
      fetcher: async (_ctx, id: string) => `data-${id}`,
    })
    const def = defineController((ctx, props: { id: ReadSignal<string> }) => ({
      x: createQuery(ctx, q, () => [props.id.value] as [string]),
    }))
    const id = signal('a')
    const root = createTestController(def, {
      deps: emptyDeps,
      props: { id },
      queries: queryEngine({ defaults: { keepPreviousData: true } }),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.x.data.value).toBe('data-a')

    id.set('b')
    // Previous key's data survives while the new key is in flight.
    expect(root.api.x.data.value).toBe('data-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.x.data.value).toBe('data-b')
    root.dispose()
  })
})

describe('queryEngine({ defaults }) — refetch flags and precedence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('refetchOnWindowFocus via engine defaults applies', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-default-options/252',
      key: () => ['rf'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { refetchOnWindowFocus: true } }),
      deps: emptyDeps,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)
    root.dispose()
  })

  test('a per-query spec flag overrides the engine default', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-default-options/289',
      key: () => ['rf-spec'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { refetchOnWindowFocus: false } }),
      deps: emptyDeps,
    })
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)
    root.dispose()
  })
})

describe('queryEngine({ defaults }) — ctx.cache', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('root staleTime applies to a controller-local ctx.cache', async () => {
    const def = defineController((ctx) => ({
      user: createCache(ctx, async () => 'u1'),
    }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { staleTime: 60_000 } }),
      deps: emptyDeps,
    })
    await flush()
    expect(root.api.user.status.value).toBe('success')
    expect(root.api.user.isStale.value).toBe(false)
    root.dispose()
  })

  test('explicit ctx.cache staleTime overrides the root default', async () => {
    const def = defineController((ctx) => ({
      user: createCache(ctx, async () => 'u1', { staleTime: 0 }),
    }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { staleTime: 60_000 } }),
      deps: emptyDeps,
    })
    await flush()
    expect(root.api.user.isStale.value).toBe(true)
    root.dispose()
  })
})

describe('queryEngine({ defaults }) — infinite queries', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('root retry applies to an infinite query that omits it', async () => {
    let attempts = 0
    const q = defineInfiniteQuery({
      id: 'query-default-options/348',
      key: () => ['inf-r'],
      fetcher: async () => {
        attempts++
        throw new Error('boom')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({ f: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { retry: 1, retryDelay: 10 } }),
      deps: emptyDeps,
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(attempts).toBe(2) // initial + 1 retry
    root.dispose()
  })

  test('root staleTime reaches the infinite entry', async () => {
    const q = defineInfiniteQuery({
      id: 'query-default-options/371',
      key: () => ['inf-s'],
      fetcher: async () => ({ items: [1] as number[], next: null as number | null }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.next,
      itemsOf: (page) => page.items,
    })
    const def = defineController((ctx) => ({ f: createQuery(ctx, q) }))
    const root = createTestController(def, {
      deps: emptyDeps,
      props: undefined,
      queries: queryEngine({ defaults: { staleTime: 60_000 } }),
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.f.isStale.value).toBe(false)

    await vi.advanceTimersByTimeAsync(61_000)
    expect(root.api.f.isStale.value).toBe(true)
    root.dispose()
  })
})
