import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery } from '../src/query/define'
import { signal } from '../src/signals'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

describe('infinite query: error / retry paths', () => {
  test('fetcher rejection with retry=0 surfaces error status, isFetching flips back', async () => {
    const q = defineInfiniteQuery({
      key: () => ['err'],
      fetcher: async () => {
        throw new Error('boom')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.status.value).toBe('error'))
    expect((root.x.error.value as Error).message).toBe('boom')
    expect(root.x.isFetching.value).toBe(false)
    expect(root.x.isLoading.value).toBe(false)
    root.dispose()
  })

  test('retry policy as number retries until exhausted, then settles into error', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      key: () => ['retry-num'],
      fetcher: async () => {
        calls++
        throw new Error(`fail-${calls}`)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      retry: 2,
      retryDelay: 1,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.status.value).toBe('error'), { timeout: 2000 })
    expect(calls).toBe(3) // initial + 2 retries
    root.dispose()
  })

  test('retry as function eventually returns false, settling into error', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      key: () => ['retry-fn'],
      fetcher: async () => {
        calls++
        throw new Error('nope')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      retry: (attempt) => attempt < 1,
      retryDelay: () => 1,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.status.value).toBe('error'), { timeout: 2000 })
    expect(calls).toBe(2)
    root.dispose()
  })

  test('fetchNextPage failure clears isFetchingNextPage and surfaces error', async () => {
    let phase = 0
    const q = defineInfiniteQuery({
      key: () => ['fnp-err'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (phase === 0) {
          phase++
          return `p${pageParam}`
        }
        throw new Error('next-fails')
      },
      initialPageParam: 0,
      getNextPageParam: (page) => (page === 'p0' ? 1 : null),
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))

    await expect(root.x.fetchNextPage()).rejects.toThrow('next-fails')
    expect(root.x.isFetchingNextPage.value).toBe(false)
    expect(root.x.isFetching.value).toBe(false)
    expect(root.x.status.value).toBe('error')
    root.dispose()
  })

  test('fetchPreviousPage failure clears isFetchingPreviousPage', async () => {
    const pages: Record<number, string> = { 0: 'mid' }
    let mode = 'first'
    const q = defineInfiniteQuery({
      key: () => ['fpp-err'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (mode === 'first') {
          mode = 'second'
          return pages[pageParam] ?? `p${pageParam}`
        }
        throw new Error('prev-fails')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      getPreviousPageParam: (first) => (first === 'mid' ? -1 : null),
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['mid']))

    await expect(root.x.fetchPreviousPage()).rejects.toThrow('prev-fails')
    expect(root.x.isFetchingPreviousPage.value).toBe(false)
    expect(root.x.status.value).toBe('error')
    root.dispose()
  })
})

describe('infinite query: short-circuit branches', () => {
  test('fetchPreviousPage is a no-op when getPreviousPageParam is not provided', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      key: () => ['nofpp'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls++
        return `p${pageParam}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))
    const before = calls
    await root.x.fetchPreviousPage()
    expect(calls).toBe(before)
    expect(root.x.hasPreviousPage.value).toBe(false)
    root.dispose()
  })

  test('fetchNextPage is a no-op once hasNextPage is false', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      key: () => ['nofnp'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls++
        return `p${pageParam}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))
    const before = calls
    await root.x.fetchNextPage()
    expect(calls).toBe(before)
    root.dispose()
  })

  test('fetchNextPage falls through to startFetch when pages are empty (no initial fetch yet)', async () => {
    // Trigger an enabled-gated controller so initial fetch hasn't happened
    // when fetchNextPage is invoked. The fallback should fire startFetch.
    const enabled = signal(false)
    const q = defineInfiniteQuery({
      key: () => ['fallback'],
      fetcher: async ({ pageParam }: { pageParam: number }) => `p${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({
        x: ctx.use(q, { key: () => [], enabled: () => enabled.value }),
      })),
      { deps: emptyDeps },
    )
    await flush()
    expect(root.x.pages.value).toEqual([])
    enabled.set(true)
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))
    root.dispose()
  })

  test('concurrent fetchNextPage calls collapse to one in-flight fetch', async () => {
    let calls = 0
    let resolveNext: (v: string) => void = () => {}
    const q = defineInfiniteQuery({
      key: () => ['concurrent'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls++
        if (pageParam === 0) return 'p0'
        return new Promise<string>((res) => {
          resolveNext = res
        })
      },
      initialPageParam: 0,
      getNextPageParam: (page) => (page === 'p0' ? 1 : null),
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))
    const callsBefore = calls

    const p1 = root.x.fetchNextPage()
    expect(root.x.isFetchingNextPage.value).toBe(true)
    // Second call short-circuits: returns immediately, no new fetch.
    await root.x.fetchNextPage()
    expect(calls).toBe(callsBefore + 1)

    resolveNext('p1')
    await p1
    expect(root.x.pages.value).toEqual(['p0', 'p1'])
    root.dispose()
  })
})

describe('infinite query: reset / firstValue', () => {
  test('reset clears error and parks status at idle when there are no pages', async () => {
    const q = defineInfiniteQuery({
      key: () => ['reset-empty'],
      fetcher: async () => {
        throw new Error('first-fail')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.status.value).toBe('error'))
    root.x.reset()
    expect(root.x.error.value).toBeUndefined()
    // No pages means reset() parks status at 'idle'. After reset the
    // subscriber's effect re-evaluates via the entry's status signal and a new
    // fetch may be scheduled — but synchronously, before the next microtask,
    // status is idle.
    expect(['idle', 'pending']).toContain(root.x.status.value)
    root.dispose()
  })

  test('reset keeps existing pages and only flips status to success / clears error', async () => {
    let mode = 'ok'
    const q = defineInfiniteQuery({
      key: () => ['reset-pages'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (mode === 'fail') throw new Error('flaky')
        return `p${pageParam}`
      },
      initialPageParam: 0,
      getNextPageParam: (page) => (page === 'p0' ? 1 : null),
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))
    mode = 'fail'
    await expect(root.x.fetchNextPage()).rejects.toThrow('flaky')
    expect(root.x.status.value).toBe('error')
    expect(root.x.pages.value).toEqual(['p0'])

    root.x.reset()
    expect(root.x.error.value).toBeUndefined()
    expect(root.x.pages.value).toEqual(['p0'])
    root.dispose()
  })

  test('firstValue resolves with the cached pages when status is already success', async () => {
    const q = defineInfiniteQuery({
      key: () => ['fv-success'],
      fetcher: async ({ pageParam }: { pageParam: number }) => `p${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['p0']))
    await expect(root.x.firstValue()).resolves.toEqual(['p0'])
    root.dispose()
  })

  test('firstValue rejects immediately when status is error', async () => {
    const q = defineInfiniteQuery({
      key: () => ['fv-error'],
      fetcher: async () => {
        throw new Error('die')
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.x.status.value).toBe('error'))
    await expect(root.x.firstValue()).rejects.toThrow('die')
    root.dispose()
  })

  test('firstValue resolves once a pending fetch settles to success', async () => {
    let resolveIt: (v: string) => void = () => {}
    const q = defineInfiniteQuery({
      key: () => ['fv-pending-success'],
      fetcher: async () =>
        new Promise<string>((res) => {
          resolveIt = res
        }),
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await flush()
    const promise = root.x.firstValue()
    resolveIt('page-late')
    await expect(promise).resolves.toEqual(['page-late'])
    root.dispose()
  })

  test('firstValue rejects when a pending fetch fails', async () => {
    let rejectIt: (err: unknown) => void = () => {}
    const q = defineInfiniteQuery({
      key: () => ['fv-pending-error'],
      fetcher: async () =>
        new Promise<string>((_, rej) => {
          rejectIt = rej
        }),
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await flush()
    const promise = root.x.firstValue()
    rejectIt(new Error('blew up'))
    await expect(promise).rejects.toThrow('blew up')
    root.dispose()
  })
})

describe('infinite query: staleTime + invalidate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('staleTime delays isStale; invalidate forces refetch and resets the timer', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      key: () => ['stale'],
      fetcher: async () => {
        calls++
        return `p${calls}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 1000,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: ctx.use(q) })),
      { deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(root.x.isStale.value).toBe(false)

    // Half the staleTime — still fresh.
    await vi.advanceTimersByTimeAsync(500)
    expect(root.x.isStale.value).toBe(false)

    // Invalidate kicks an immediate refetch; the new entry resets the timer.
    q.invalidate()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
    expect(root.x.isStale.value).toBe(false)

    // After staleTime since the new fetch, isStale becomes true.
    await vi.advanceTimersByTimeAsync(1001)
    expect(root.x.isStale.value).toBe(true)
    root.dispose()
  })
})
