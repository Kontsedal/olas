/**
 * `query/infinite.ts` paths the main suites leave dark: paging flags before
 * the first page, paging after a failed first load, previous-page dedupe and
 * its end, a superseded page response, page retries and the default backoff,
 * the retry loops' supersede checks, single-use finalize, forced staleness,
 * the stale timer across refetch and streamed hydration, `firstValue` on
 * dispose, and a subscription whose entry was collected while suspended.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  bindQuery,
  createQuery,
  createRoot,
  type DebugEvent,
  defineController,
  defineInfiniteQuery,
  isAbortError,
  queryEngine,
} from '../src'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
  vi.useRealTimers()
})
const keep = <T extends { dispose(): void }>(r: T): T => {
  roots.push(r)
  return r
}
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Page = { n: number }
const page = (n: number): Page => ({ n })

/** Pages -1 (first) through 2 (last); paging stops at both ends. */
const bidirectional = {
  initialPageParam: 0,
  getNextPageParam: (p: Page) => (p.n < 2 ? p.n + 1 : null),
  getPreviousPageParam: (p: Page) => (p.n > -1 ? p.n - 1 : null),
}

/** A fetcher whose every call waits for the test to settle it. */
function gatedFetcher() {
  const calls: Array<{ n: number; gate: Deferred<Page>; signal: AbortSignal }> = []
  const fetcher = ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) => {
    const gate = deferred<Page>()
    calls.push({ n: pageParam, gate, signal })
    return gate.promise
  }
  return { calls, fetcher }
}

describe('paging controls', () => {
  test('hasNextPage and hasPreviousPage are false until the first page lands', async () => {
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'cov-inf/has-before-load',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    const { feed } = root.api
    expect(feed.hasNextPage.value).toBe(false)
    expect(feed.hasPreviousPage.value).toBe(false)
    calls[0]?.gate.resolve(page(0))
    await flush()
    expect(feed.hasNextPage.value).toBe(true)
    expect(feed.hasPreviousPage.value).toBe(true)
  })

  test('paging either way after a failed first load fetches the first page', async () => {
    const failedOnce = new Set<string>()
    const inf = defineInfiniteQuery({
      id: 'cov-inf/page-after-failure',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }, k: string) => {
        if (!failedOnce.has(k)) {
          failedOnce.add(k)
          throw new Error('first load failed')
        }
        return page(pageParam)
      },
      ...bidirectional,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          forward: createQuery(ctx, inf, () => ['forward']),
          backward: createQuery(ctx, inf, () => ['backward']),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    expect(root.api.forward.status.value).toBe('error')
    expect(root.api.backward.status.value).toBe('error')

    await root.api.forward.fetchNextPage()
    await root.api.backward.fetchPreviousPage()
    expect(root.api.forward.pages.value).toEqual([page(0)])
    expect(root.api.backward.pages.value).toEqual([page(0)])
    expect(root.api.backward.status.value).toBe('success')
  })

  test('fetchPreviousPage joins the one in flight and stops at the first page', async () => {
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'cov-inf/prev-dedupe',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    calls[0]?.gate.resolve(page(0))
    await flush()
    const { feed } = root.api

    const first = feed.fetchPreviousPage()
    const second = feed.fetchPreviousPage()
    expect(calls).toHaveLength(2) // the second call joined the first
    expect(feed.isFetchingPreviousPage.value).toBe(true)
    calls[1]?.gate.resolve(page(-1))
    await Promise.all([first, second])
    expect(feed.pages.value).toEqual([page(-1), page(0)])
    expect(feed.hasPreviousPage.value).toBe(false)

    await feed.fetchPreviousPage() // nothing before page -1
    expect(calls).toHaveLength(2)
  })

  test('a next page that arrives after a refetch superseded it is dropped', async () => {
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'cov-inf/next-superseded',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    calls[0]?.gate.resolve(page(0))
    await flush()
    const { feed } = root.api

    const paging = feed.fetchNextPage().catch((e: unknown) => e)
    const refetch = feed.refetch()
    expect(calls.map((c) => c.n)).toEqual([0, 1, 0])
    expect(calls[1]?.signal.aborted).toBe(true)

    calls[1]?.gate.resolve(page(1)) // the fetcher ignored its signal
    expect(isAbortError(await paging)).toBe(true)
    expect(feed.isFetchingNextPage.value).toBe(false)
    calls[2]?.gate.resolve(page(0))
    await refetch
    expect(feed.pages.value).toEqual([page(0)])
  })
})

describe('retries', () => {
  test('a page fetch retries under a retry function, after retryDelay', async () => {
    vi.useFakeTimers()
    let failNext = false
    let nextCalls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-inf/page-retry-fn',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => {
        if (pageParam === 1) {
          nextCalls += 1
          if (failNext) {
            failNext = false
            throw new Error('blip')
          }
        }
        return page(pageParam)
      },
      ...bidirectional,
      retry: (attempt) => attempt < 1,
      retryDelay: 50,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    failNext = true
    const paging = root.api.feed.fetchNextPage()
    await vi.advanceTimersByTimeAsync(0)
    expect(nextCalls).toBe(1)
    expect(root.api.feed.isFetchingNextPage.value).toBe(true) // waiting out the backoff
    await vi.advanceTimersByTimeAsync(50)
    await paging
    expect(nextCalls).toBe(2)
    expect(root.api.feed.pages.value).toEqual([page(0), page(1)])
  })

  test('without retryDelay, retries back off exponentially from one second', async () => {
    vi.useFakeTimers()
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-inf/default-backoff',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => {
        calls += 1
        if (calls < 3) throw new Error('flaky')
        return page(pageParam)
      },
      ...bidirectional,
      retry: 2,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2) // 1s
    await vi.advanceTimersByTimeAsync(1_999)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(3) // then 2s
    expect(root.api.feed.pages.value).toEqual([page(0)])
  })

  test('a cancel landing as the first-page backoff expires stops the next attempt', async () => {
    vi.useFakeTimers()
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-inf/cancel-at-backoff',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        calls += 1
        throw new Error('flaky')
      },
      ...bidirectional,
      retry: 1,
      retryDelay: 10,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf), h: bindQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    setTimeout(() => root.api.h.cancel(), 11)
    // One synchronous advance fires the backoff (t=10) and the cancel (t=11)
    // before the retry loop's continuation gets a microtask.
    vi.advanceTimersByTime(20)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(root.api.feed.status.value).toBe('idle')
    expect(root.api.feed.isFetching.value).toBe(false)
  })

  test('a cancel landing as a page backoff expires stops the next attempt', async () => {
    vi.useFakeTimers()
    let nextCalls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-inf/cancel-page-at-backoff',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => {
        if (pageParam === 1) {
          nextCalls += 1
          throw new Error('flaky')
        }
        return page(pageParam)
      },
      ...bidirectional,
      retry: 1,
      retryDelay: 10,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf), h: bindQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    const paging = root.api.feed.fetchNextPage().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(nextCalls).toBe(1)
    setTimeout(() => root.api.h.cancel(), 11)
    vi.advanceTimersByTime(20)
    await vi.advanceTimersByTimeAsync(0)
    expect(isAbortError(await paging)).toBe(true)
    expect(nextCalls).toBe(1)
    expect(root.api.feed.isFetchingNextPage.value).toBe(false)
    expect(root.api.feed.pages.value).toEqual([page(0)])
    expect(root.api.feed.status.value).toBe('success')
  })
})

describe('snapshots and staleness', () => {
  test('finalize is single-use, and pending stays true while another layer is live', async () => {
    const inf = defineInfiniteQuery({
      id: 'cov-inf/finalize',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      ...bidirectional,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf), h: bindQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => events.push(e))
    const finalized = () => events.filter((e) => e.type === 'snapshot:finalize').length

    const a = root.api.h.setData((pages) => [...(pages ?? []), page(1)])
    const b = root.api.h.setData((pages) => [...(pages ?? []), page(2)])
    a.finalize()
    expect(root.api.feed.hasPendingMutations.value).toBe(true) // b is still live
    a.finalize()
    a.rollback() // a is settled; neither call does anything
    expect(finalized()).toBe(1)
    expect(root.api.feed.pages.value).toEqual([page(0), page(1), page(2)])
    b.finalize()
    expect(root.api.feed.hasPendingMutations.value).toBe(false)
    expect(finalized()).toBe(2)
  })

  test('prefetch after invalidating a subscriber-less entry refetches despite staleTime', async () => {
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'cov-inf/forced-stale',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const h = root.bindQuery(inf)
    await h.prefetch()
    await h.prefetch()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await h.invalidate() // no subscriber: marked stale, not refetched
    expect(fetcher).toHaveBeenCalledTimes(1)
    await h.prefetch()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('a refetch within staleTime restarts the stale timer', async () => {
    vi.useFakeTimers()
    const inf = defineInfiniteQuery({
      id: 'cov-inf/stale-restart',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      ...bidirectional,
      staleTime: 1_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(600)
    await root.api.feed.refetch()
    await vi.advanceTimersByTimeAsync(400) // the first timer's deadline
    expect(root.api.feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(600) // the refetch's deadline
    expect(root.api.feed.isStale.value).toBe(true)
  })

  test('a streamed payload over loaded pages restarts the stale timer from its timestamp', async () => {
    vi.useFakeTimers()
    const inf = defineInfiniteQuery({
      id: 'cov-inf/stream-stale',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      ...bidirectional,
      staleTime: 1_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    root.hydrate({
      version: 1,
      entries: [
        {
          id: 'cov-inf/stream-stale',
          key: ['feed'],
          data: [page(5)],
          pageParams: [5],
          lastUpdatedAt: Date.now(),
        },
      ],
    })
    expect(root.api.feed.pages.value).toEqual([page(5)])
    expect(root.api.feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(500) // the fetch's deadline
    expect(root.api.feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(500) // the payload's deadline
    expect(root.api.feed.isStale.value).toBe(true)
  })
})

describe('teardown', () => {
  test('disposing rejects a pending firstValue with an AbortError', async () => {
    const { fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'cov-inf/first-value-dispose',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    const first = root.api.feed.firstValue().catch((e: unknown) => e)
    await flush() // let the waiter reach the entry
    root.dispose()
    expect(isAbortError(await first)).toBe(true)
  })

  test('a suspended subscription whose entry was collected fails fast until resumed', async () => {
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'cov-inf/suspended-gc',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      gcTime: 0,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await root.waitForIdle()
    root.suspend() // releases the entry; gcTime 0 collects it at once
    expect(root.debug.queryEntries()).toEqual([])
    const { feed } = root.api
    expect(feed.pages.value).toEqual([page(0)]) // the last committed pages still read

    await expect(feed.refetch()).rejects.toThrow()
    await expect(feed.fetchNextPage()).rejects.toThrow()
    await expect(feed.fetchPreviousPage()).rejects.toThrow()
    feed.reset()
    expect(feed.status.value).toBe('success')
    expect(isAbortError(await feed.firstValue().catch((e: unknown) => e))).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)

    root.resume() // rebinds a fresh entry and fetches
    expect(await feed.firstValue()).toEqual([page(0)])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
