// @vitest-environment jsdom
/**
 * `InfiniteEntry` at the edges of its state machine (`query/infinite.ts`,
 * spec §5.5, §5.7, §5.11, §6.4): the resting state of a fresh or seeded entry
 * and the staleness a payload's age implies; the loading, fetching and stale
 * flags across a first load, a refetch and an invalidate; a refetch that ends
 * early, shares its head page, or is superseded before it commits; the error,
 * flags and timestamp each page settles with; retry attempts, and a retry
 * policy that throws; writes, the status they lift and the params they pad;
 * a snapshot layer that settles once; cancel, reset and hydration over each
 * status; which network modes park on a `TypeError`; an entry collected
 * mid-flight; and the fetch events the devtools bus receives.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  bindQuery,
  createQuery,
  createRoot,
  type DebugEvent,
  type DehydratedState,
  defineController,
  defineInfiniteQuery,
  effect,
  type InfiniteQuery,
  type InfiniteQuerySubscription,
  isAbortError,
  queryEngine,
  signal,
} from '../src'
import { __resetFocusOnlineForTests } from '../src/query/focus-online'
import { InfiniteEntry } from '../src/query/infinite'
import { type Controllable, controllable, flushMicrotasks } from './property/helpers'

const owned: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const o of owned.splice(0)) o.dispose()
  __resetFocusOnlineForTests()
  vi.unstubAllGlobals()
  setOnline(true)
  vi.useRealTimers()
})
const keep = <T extends { dispose(): void }>(o: T): T => {
  owned.push(o)
  return o
}

function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
}
const reconnect = (): void => {
  setOnline(true)
  window.dispatchEvent(new Event('online'))
}

type Page = { n: number; tag?: string }
const page = (n: number, tag?: string): Page => (tag === undefined ? { n } : { n, tag })

/** Pages -1 (first) through 2 (last); paging stops at both ends. */
const bidirectional = {
  initialPageParam: 0,
  getNextPageParam: (p: Page): number | null => (p.n < 2 ? p.n + 1 : null),
  getPreviousPageParam: (p: Page): number | null => (p.n > -1 ? p.n - 1 : null),
}

const load = async ({ pageParam }: { pageParam: number }): Promise<Page> => page(pageParam)

type Call = { n: number; gate: Controllable<Page>; signal: AbortSignal }

/** A fetcher whose every call waits for the test to settle it. */
function gatedFetcher(honorsAbort = false) {
  const calls: Call[] = []
  const fetcher = ({
    pageParam,
    signal,
  }: {
    pageParam: number
    signal: AbortSignal
  }): Promise<Page> => {
    const gate = controllable<Page>(signal, honorsAbort)
    calls.push({ n: pageParam, gate, signal })
    return gate.promise
  }
  return { calls, fetcher }
}

/** A root with one subscription to `inf` and a handle bound to it. */
function mount<TPage, TItem>(inf: InfiniteQuery<[], TPage, TItem>, hydrate?: DehydratedState) {
  return keep(
    createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, inf), h: bindQuery(ctx, inf) })),
      { queries: queryEngine(), deps: {}, hydrate },
    ),
  )
}

/** A root with only a handle: the entries it binds have no subscriber. */
function handleOnly<TPage, TItem>(inf: InfiniteQuery<[], TPage, TItem>) {
  return keep(
    createRoot(
      defineController((ctx) => ({ h: bindQuery(ctx, inf) })),
      { queries: queryEngine(), deps: {} },
    ),
  )
}

/** One infinite entry's payload, keyed `['feed']`. */
function payload(
  id: string,
  pages: Page[],
  pageParams: number[],
  lastUpdatedAt = Date.now(),
): DehydratedState {
  return { version: 1, entries: [{ id, key: ['feed'], data: pages, pageParams, lastUpdatedAt }] }
}

const directions = ['next', 'prev'] as const
type Direction = (typeof directions)[number]
/** The page param a request in `direction` asks for, from a loaded page 0. */
const paramFor = (direction: Direction): number => (direction === 'next' ? 1 : -1)
function pager(feed: InfiniteQuerySubscription<Page, Page>, direction: Direction) {
  return direction === 'next'
    ? { run: feed.fetchNextPage, flag: feed.isFetchingNextPage }
    : { run: feed.fetchPreviousPage, flag: feed.isFetchingPreviousPage }
}

describe('a fresh or seeded entry', () => {
  test('a fresh payload seeds settled pages that stay fresh until staleTime runs out', async () => {
    vi.useFakeTimers()
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/seeded',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 1_000,
    })
    const root = mount(inf, payload('mut-inf/seeded', [page(0), page(1)], [0, 1]))
    const { feed } = root.api
    expect(feed.status.value).toBe('success')
    expect(feed.isLoading.value).toBe(false)
    expect(feed.isPaused.value).toBe(false)
    expect(feed.isFetching.value).toBe(false)
    expect(feed.isStale.value).toBe(false)
    expect(calls).toHaveLength(0)
    const dehydrated = root.dehydrate().entries.find((e) => e.id === 'mut-inf/seeded')
    expect(dehydrated?.pageParams).toEqual([0, 1])

    await vi.advanceTimersByTimeAsync(999)
    expect(feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(feed.isStale.value).toBe(true)
  })

  test("a payload's age counts against staleTime", async () => {
    vi.useFakeTimers()
    const { fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/seeded-aged',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 1_000,
    })
    const { feed } = mount(
      inf,
      payload('mut-inf/seeded-aged', [page(0)], [0], Date.now() - 400),
    ).api
    expect(feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(599)
    expect(feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(feed.isStale.value).toBe(true)
  })

  test.each([1_000, 5_000])('a payload %i ms old under a 1000 ms staleTime seeds stale', (age) => {
    vi.useFakeTimers()
    const { fetcher } = gatedFetcher()
    const id = `mut-inf/seeded-old-${age}`
    const inf = defineInfiniteQuery({
      id,
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 1_000,
    })
    const { feed } = mount(inf, payload(id, [page(0)], [0], Date.now() - age)).api
    expect(feed.pages.value).toEqual([page(0)])
    expect(feed.isStale.value).toBe(true)
  })

  test('with staleTime 0, a payload stamped ahead of the client clock seeds stale', () => {
    const { fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/seeded-future',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const { feed } = mount(
      inf,
      payload('mut-inf/seeded-future', [page(0)], [0], Date.now() + 5_000),
    ).api
    expect(feed.pages.value).toEqual([page(0)])
    expect(feed.isStale.value).toBe(true)
  })

  test('an empty seed leaves the entry idle, and seeded pages without params start with none', () => {
    const empty = keep(
      new InfiniteEntry<Page, Page, number>({
        fetcher: load,
        ...bidirectional,
        initialPages: [],
        initialPageParams: [],
        initialUpdatedAt: Date.now(),
      }),
    )
    expect(empty.status.peek()).toBe('idle')
    expect(empty.lastUpdatedAt.peek()).toBeUndefined()

    const unaligned = keep(
      new InfiniteEntry<Page, Page, number>({
        fetcher: load,
        ...bidirectional,
        initialPages: [page(0)],
        initialUpdatedAt: Date.now(),
      }),
    )
    expect(unaligned.status.peek()).toBe('success')
    expect(unaligned.pageParams.peek()).toEqual([])
  })

  test('an entry without an onSuccessData hook still settles every page it fetches', async () => {
    const entry = keep(new InfiniteEntry<Page, Page, number>({ fetcher: load, ...bidirectional }))
    await expect(entry.startFetch()).resolves.toEqual(page(0))
    await entry.fetchNextPage()
    await entry.fetchPreviousPage()
    expect(entry.pages.peek()).toEqual([page(-1), page(0), page(1)])
    expect(entry.status.peek()).toBe('success')
    expect(entry.error.peek()).toBeUndefined()
  })
})

describe('the first load and refetches', () => {
  test('the first page loads marked stale, then lands neither loading nor fetching', async () => {
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/first-load',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const { feed } = mount(inf).api
    expect(feed.isLoading.value).toBe(true)
    expect(feed.isStale.value).toBe(true)
    calls[0]?.gate.resolve(page(0))
    await flushMicrotasks()
    expect(feed.status.value).toBe('success')
    expect(feed.isLoading.value).toBe(false)
    expect(feed.isFetching.value).toBe(false)
    expect(feed.isStale.value).toBe(true) // staleTime 0: stale on arrival
  })

  test('a refetch of loaded pages is fetching but not loading', async () => {
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/refetch-flags',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const { feed } = mount(inf).api
    calls[0]?.gate.resolve(page(0))
    await flushMicrotasks()
    const refetch = feed.refetch()
    expect(feed.isFetching.value).toBe(true)
    expect(feed.isLoading.value).toBe(false)
    calls[1]?.gate.resolve(page(0))
    await refetch
    expect(feed.isFetching.value).toBe(false)
  })

  test('a successful refetch clears the error a failed page left', async () => {
    const down = new Error('page 1 down')
    const inf = defineInfiniteQuery({
      id: 'mut-inf/refetch-clears-error',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam === 1) throw down
        return page(pageParam)
      },
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    await expect(feed.fetchNextPage()).rejects.toBe(down)
    expect(feed.status.value).toBe('error')
    await feed.refetch()
    expect(feed.error.value).toBeUndefined()
    expect(feed.status.value).toBe('success')
    expect(feed.pages.value).toEqual([page(0)])
  })

  test('a refetch stops at the page the refreshed data now ends on', async () => {
    let last = 2
    const fetched: number[] = []
    const inf = defineInfiniteQuery({
      id: 'mut-inf/refetch-shrinks',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        fetched.push(pageParam)
        return page(pageParam)
      },
      initialPageParam: 0,
      getNextPageParam: (p: Page): number | null => (p.n < last ? p.n + 1 : null),
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    await feed.fetchNextPage()
    await feed.fetchNextPage()
    expect(feed.pages.value).toEqual([page(0), page(1), page(2)])

    last = 1 // the server now ends after page 1
    fetched.length = 0
    await feed.refetch()
    expect(fetched).toEqual([0, 1])
    expect(feed.pages.value).toEqual([page(0), page(1)])
    expect(feed.hasNextPage.value).toBe(false)
  })

  test('a refetch keeps an unchanged head page by reference', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-inf/share-head',
      key: () => ['feed'],
      fetcher: load,
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    await feed.fetchNextPage()
    const head = feed.pages.value[0]
    await feed.refetch()
    expect(feed.pages.value).toEqual([page(0), page(1)])
    expect(feed.pages.value[0]).toBe(head)
  })

  test('with structuralShare off, a refetch hands back a new head page', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-inf/share-off',
      key: () => ['feed'],
      fetcher: load,
      ...bidirectional,
      structuralShare: false,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    const head = feed.pages.value[0]
    await feed.refetch()
    expect(feed.pages.value[0]).toEqual(head)
    expect(feed.pages.value[0]).not.toBe(head)
  })

  test('a superseded refetch never hands its dropped page to getNextPageParam', async () => {
    const { calls, fetcher } = gatedFetcher()
    const derivedFrom: Page[] = []
    const inf = defineInfiniteQuery({
      id: 'mut-inf/superseded-derive',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: (p: Page): number | null => {
        derivedFrom.push(p)
        return p.n < 2 ? p.n + 1 : null
      },
    })
    const { feed } = mount(inf).api
    calls[0]?.gate.resolve(page(0))
    await flushMicrotasks()

    const first = feed.refetch()
    const second = feed.refetch()
    expect(calls[1]?.signal.aborted).toBe(true)
    calls[1]?.gate.resolve(page(0, 'dropped')) // the fetcher ignored its signal
    calls[2]?.gate.resolve(page(0, 'fresh'))
    await Promise.all([first, second])
    expect(feed.pages.value).toEqual([page(0, 'fresh')])
    expect(derivedFrom.some((p) => p.tag === 'dropped')).toBe(false)
  })

  test('a refetch cancelled from inside getNextPageParam commits nothing and rejects as aborted', async () => {
    let tag: string | undefined
    let onDerive: (() => void) | undefined
    const inf = defineInfiniteQuery({
      id: 'mut-inf/cancel-while-deriving',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => page(pageParam, tag),
      initialPageParam: 0,
      getNextPageParam: (p: Page): number | null => {
        if (p.tag === 'refetched' && onDerive) {
          const run = onDerive
          onDerive = undefined
          run()
        }
        return null
      },
    })
    const root = mount(inf)
    await root.waitForIdle()
    tag = 'refetched'
    onDerive = () => root.api.h.cancel()
    const outcome = await root.api.h.prefetch().catch((e: unknown) => e)
    expect(isAbortError(outcome)).toBe(true)
    expect(root.api.feed.pages.value).toEqual([page(0)])
    expect(root.api.feed.isFetching.value).toBe(false)
  })

  test('a cancel landing as the first-page backoff expires rejects the prefetch as aborted', async () => {
    vi.useFakeTimers()
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'mut-inf/cancel-at-backoff',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        calls += 1
        throw new Error('flaky')
      },
      ...bidirectional,
      retry: 1,
      retryDelay: 10,
    })
    const root = handleOnly(inf)
    const outcome = root.api.h.prefetch().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    setTimeout(() => root.api.h.cancel(), 11)
    // One synchronous advance fires the backoff (t=10) and the cancel (t=11)
    // before the retry loop's continuation gets a microtask.
    vi.advanceTimersByTime(20)
    expect(isAbortError(await outcome)).toBe(true)
    expect(calls).toBe(1)
  })
})

describe('paging', () => {
  test.each(
    directions,
  )('a failed %s page surfaces its error; the next success clears it and restamps lastUpdatedAt', async (direction) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const down = new Error('page down')
    let failOnce = true
    const inf = defineInfiniteQuery({
      id: `mut-inf/page-error-${direction}`,
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam === paramFor(direction) && failOnce) {
          failOnce = false
          throw down
        }
        return page(pageParam)
      },
      ...bidirectional,
    })
    const { feed } = mount(inf).api
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.lastUpdatedAt.value).toBe(1_000)
    const { run } = pager(feed, direction)

    await expect(run()).rejects.toBe(down)
    expect(feed.error.value).toBe(down)
    expect(feed.status.value).toBe('error')

    vi.setSystemTime(5_000)
    await run()
    expect(feed.pages.value).toHaveLength(2)
    expect(feed.error.value).toBeUndefined()
    expect(feed.status.value).toBe('success')
    expect(feed.lastUpdatedAt.value).toBe(5_000)
  })

  test.each(
    directions,
  )('a failed %s page reports its error with the page flag already down', async (direction) => {
    const inf = defineInfiniteQuery({
      id: `mut-inf/page-error-flag-${direction}`,
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam === paramFor(direction)) throw new Error('page down')
        return page(pageParam)
      },
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    const { run, flag } = pager(feed, direction)
    const flagWhileErrored: boolean[] = []
    const stop = effect(() => {
      if (feed.status.value === 'error') flagWhileErrored.push(flag.value)
    })
    await expect(run()).rejects.toThrow('page down')
    stop()
    expect(flagWhileErrored).toEqual([false])
  })

  test('page retries count attempts up from zero until the policy gives up', async () => {
    vi.useFakeTimers()
    let pageOneCalls = 0
    const delayedAttempts: number[] = []
    const inf = defineInfiniteQuery({
      id: 'mut-inf/retry-attempts',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam === 1) {
          pageOneCalls += 1
          throw new Error('page 1 down')
        }
        return page(pageParam)
      },
      ...bidirectional,
      retry: 2,
      retryDelay: (attempt: number) => {
        delayedAttempts.push(attempt)
        return 10
      },
    })
    const { feed } = mount(inf).api
    await vi.advanceTimersByTimeAsync(0)
    const paging = feed.fetchNextPage().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(200)
    expect(pageOneCalls).toBe(3) // the first try and two retries
    expect(delayedAttempts).toEqual([0, 1])
    expect(feed.status.value).toBe('error')
    expect(await paging).toBeInstanceOf(Error)
  })

  test.each(
    directions,
  )('a retry policy that throws still takes the %s-page flag down', async (direction) => {
    const broke = new Error('policy broke')
    const inf = defineInfiniteQuery({
      id: `mut-inf/throwing-policy-${direction}`,
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam === paramFor(direction)) throw new Error('page down')
        return page(pageParam)
      },
      ...bidirectional,
      retry: () => {
        throw broke
      },
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { run, flag } = pager(root.api.feed, direction)
    await expect(run()).rejects.toBe(broke)
    expect(flag.value).toBe(false)
  })

  test('a write during the first load settles it, and a page that then fails leaves it not loading', async () => {
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/write-during-load',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const { feed, h } = mount(inf).api
    expect(feed.status.value).toBe('pending')
    h.write(() => [page(0)])
    expect(feed.status.value).toBe('success')

    const paging = feed.fetchNextPage().catch((e: unknown) => e)
    expect(calls.map((c) => c.n)).toEqual([0, 1])
    calls[1]?.gate.reject(new Error('page 1 down'))
    await paging
    expect(feed.status.value).toBe('error')
    expect(feed.isLoading.value).toBe(false)
    expect(feed.isFetching.value).toBe(false)
  })

  test('reset after a failed page returns the loaded entry to success', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-inf/reset-after-page',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (pageParam === 1) throw new Error('page 1 down')
        return page(pageParam)
      },
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    await expect(feed.fetchNextPage()).rejects.toThrow('page 1 down')
    feed.reset()
    expect(feed.status.value).toBe('success')
    expect(feed.error.value).toBeUndefined()
    expect(feed.pages.value).toEqual([page(0)])
  })
})

describe('cancel', () => {
  test('cancelling the first load settles it idle and not loading', () => {
    const { fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/cancel-first-load',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const { feed, h } = mount(inf).api
    expect(feed.isLoading.value).toBe(true)
    h.cancel()
    expect(feed.status.value).toBe('idle')
    expect(feed.isLoading.value).toBe(false)
    expect(feed.isFetching.value).toBe(false)
  })

  test('cancel on a settled entry leaves its error status alone', async () => {
    const down = new Error('down')
    const inf = defineInfiniteQuery({
      id: 'mut-inf/cancel-settled',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        throw down
      },
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed, h } = root.api
    expect(feed.status.value).toBe('error')
    h.cancel()
    expect(feed.status.value).toBe('error')
    expect(feed.error.value).toBe(down)
  })
})

describe('writes', () => {
  test('an update to an entry with no pages receives undefined', () => {
    const received: Array<Page[] | undefined> = []
    const inf = defineInfiniteQuery({
      id: 'mut-inf/update-empty',
      key: () => ['feed'],
      fetcher: load,
      ...bidirectional,
    })
    handleOnly(inf).api.h.write((prev) => {
      received.push(prev)
      return [page(0)]
    })
    expect(received).toEqual([undefined])
  })

  test('a write that adds a page pads pageParams with the last param', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-inf/pad-params',
      key: () => ['feed'],
      fetcher: load,
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    root.api.h.write((pages) => [...(pages ?? []), page(7)])
    const dehydrated = root.dehydrate().entries.find((e) => e.id === 'mut-inf/pad-params')
    expect(dehydrated?.data).toEqual([page(0), page(7)])
    expect(dehydrated?.pageParams).toEqual([0, 0])
  })

  test('a write to an idle entry makes it a fresh success that prefetch serves', async () => {
    const fetcher = vi.fn(load)
    const inf = defineInfiniteQuery({
      id: 'mut-inf/write-idle',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 60_000,
    })
    const { h } = handleOnly(inf).api
    h.write(() => [page(9)])
    await expect(h.prefetch()).resolves.toEqual(page(9))
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('an optimistic write over a failed load keeps the error status', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-inf/write-over-error',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        throw new Error('down')
      },
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const snapshot = root.api.h.setData(() => [page(0)])
    expect(root.api.feed.pages.value).toEqual([page(0)])
    expect(root.api.feed.status.value).toBe('error')
    snapshot.finalize()
  })

  test('a snapshot layer reports one push and one rollback, and settles for good', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-inf/snapshot-events',
      key: () => ['feed'],
      fetcher: load,
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => events.push(e))

    const snapshot = root.api.h.setData((pages) => [...(pages ?? []), page(1)])
    snapshot.rollback()
    snapshot.rollback()
    snapshot.finalize()
    const layers = events.map((e) => e.type).filter((t) => t.startsWith('snapshot:'))
    expect(layers).toEqual(['snapshot:push', 'snapshot:rollback'])
    expect(root.api.feed.pages.value).toEqual([page(0)])
    expect(root.api.feed.hasPendingMutations.value).toBe(false)
  })
})

describe('invalidation and staleness', () => {
  test('invalidate marks the pages stale while its refetch runs', async () => {
    const { calls, fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/invalidate-stale',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 60_000,
    })
    const { feed, h } = mount(inf).api
    calls[0]?.gate.resolve(page(0))
    await flushMicrotasks()
    expect(feed.isStale.value).toBe(false)

    const done = h.invalidate()
    expect(feed.isFetching.value).toBe(true)
    expect(feed.isStale.value).toBe(true)
    calls[1]?.gate.resolve(page(0))
    await done
    expect(feed.isStale.value).toBe(false)
  })

  test('invalidate restarts the stale window from its refetch', async () => {
    vi.useFakeTimers()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/invalidate-window',
      key: () => ['feed'],
      fetcher: load,
      ...bidirectional,
      staleTime: 1_000,
    })
    const { feed, h } = mount(inf).api
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    await h.invalidate()
    expect(feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(600) // past the first load's deadline
    expect(feed.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(400) // the refetch's deadline
    expect(feed.isStale.value).toBe(true)
  })

  test('a subscriber that mounts after a subscriber-less invalidate refetches inside staleTime', async () => {
    const fetcher = vi.fn(load)
    const inf = defineInfiniteQuery({
      id: 'mut-inf/mount-after-invalidate',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 60_000,
    })
    const on = signal(false)
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          feed: createQuery(ctx, inf, { key: () => [], enabled: () => on.value }),
          h: bindQuery(ctx, inf),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.api.h.prefetch()
    await root.api.h.invalidate() // no subscriber: marked stale, not refetched
    expect(fetcher).toHaveBeenCalledTimes(1)
    on.set(true)
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('an entry whose first load failed refetches on window focus', async () => {
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'mut-inf/focus-after-failure',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls += 1
        if (calls === 1) throw new Error('down')
        return page(pageParam)
      },
      ...bidirectional,
      refetchOnWindowFocus: true,
    })
    const root = mount(inf)
    await root.waitForIdle()
    expect(root.api.feed.status.value).toBe('error')
    window.dispatchEvent(new Event('focus'))
    await flushMicrotasks()
    await root.waitForIdle()
    expect(calls).toBe(2)
    expect(root.api.feed.pages.value).toEqual([page(0)])
  })
})

describe('hydration over a live entry', () => {
  test('a payload over a failed load clears the error and settles success', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-inf/hydrate-over-error',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        throw new Error('down')
      },
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    expect(feed.status.value).toBe('error')
    root.hydrate(payload('mut-inf/hydrate-over-error', [page(0)], [0]))
    expect(feed.status.value).toBe('success')
    expect(feed.error.value).toBeUndefined()
    expect(feed.pages.value).toEqual([page(0)])
  })

  test("a payload during the first load ends loading and takes the payload's timestamp", () => {
    const { fetcher } = gatedFetcher()
    const inf = defineInfiniteQuery({
      id: 'mut-inf/hydrate-during-load',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
    })
    const root = mount(inf)
    const { feed } = root.api
    expect(feed.isLoading.value).toBe(true)
    const stamp = Date.now() - 1_000
    root.hydrate(payload('mut-inf/hydrate-during-load', [page(0)], [0], stamp))
    expect(feed.isLoading.value).toBe(false)
    expect(feed.isFetching.value).toBe(false)
    expect(feed.lastUpdatedAt.value).toBe(stamp)
  })

  test('after a fresh payload, prefetch serves its pages without refetching', async () => {
    const fetcher = vi.fn(load)
    const inf = defineInfiniteQuery({
      id: 'mut-inf/hydrate-then-prefetch',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      staleTime: 60_000,
    })
    const root = handleOnly(inf)
    await root.api.h.prefetch()
    root.hydrate(payload('mut-inf/hydrate-then-prefetch', [page(5)], [5]))
    await expect(root.api.h.prefetch()).resolves.toEqual(page(5))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('network modes', () => {
  test('offlineFirst surfaces a TypeError raised while online', async () => {
    const failure = new TypeError('Failed to fetch')
    const inf = defineInfiniteQuery({
      id: 'mut-inf/offline-first-online',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        throw failure
      },
      ...bidirectional,
      networkMode: 'offlineFirst',
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    expect(feed.status.value).toBe('error')
    expect(feed.error.value).toBe(failure)
    expect(feed.isPaused.value).toBe(false)
  })

  test('online mode surfaces a TypeError even when the network dropped mid-fetch', async () => {
    const failure = new TypeError('Failed to fetch')
    const inf = defineInfiniteQuery({
      id: 'mut-inf/online-dropped',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        setOnline(false)
        throw failure
      },
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    expect(feed.status.value).toBe('error')
    expect(feed.error.value).toBe(failure)
    expect(feed.isPaused.value).toBe(false)
  })

  test('a page parked offline keeps the entry settled, then resumes unpaused', async () => {
    let failOffline = false
    const inf = defineInfiniteQuery({
      id: 'mut-inf/park-page',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        if (failOffline) {
          failOffline = false
          throw new TypeError('Failed to fetch')
        }
        return page(pageParam)
      },
      ...bidirectional,
      networkMode: 'offlineFirst',
    })
    const root = mount(inf)
    await root.waitForIdle()
    const { feed } = root.api
    setOnline(false)
    failOffline = true
    const paging = feed.fetchNextPage()
    await flushMicrotasks()
    expect(feed.isPaused.value).toBe(true)
    expect(feed.isFetching.value).toBe(false)
    expect(feed.isLoading.value).toBe(false)
    expect(feed.status.value).toBe('success')

    reconnect()
    await paging
    expect(feed.pages.value).toEqual([page(0), page(1)])
    expect(feed.isPaused.value).toBe(false)
  })

  test('without a navigator the entry counts as online', async () => {
    vi.stubGlobal('navigator', undefined)
    const inf = defineInfiniteQuery({
      id: 'mut-inf/no-navigator',
      key: () => ['feed'],
      fetcher: load,
      ...bidirectional,
    })
    const root = mount(inf)
    await root.waitForIdle()
    await root.api.feed.fetchNextPage()
    expect(root.api.feed.pages.value).toEqual([page(0), page(1)])
    expect(root.api.feed.isPaused.value).toBe(false)
  })
})

describe('an entry collected mid-flight', () => {
  test('paging a suspended subscription whose entry was collected starts nothing', async () => {
    const fetcher = vi.fn(load)
    const inf = defineInfiniteQuery({
      id: 'mut-inf/collected-paging',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      gcTime: 0,
    })
    const root = mount(inf)
    await root.waitForIdle()
    root.suspend() // releases the entry; gcTime 0 collects it at once
    expect(root.debug.queryEntries()).toEqual([])
    const { feed } = root.api
    await expect(feed.fetchNextPage()).rejects.toThrow()
    await expect(feed.fetchPreviousPage()).rejects.toThrow()
    expect(feed.isFetching.value).toBe(false)
    expect(feed.isFetchingNextPage.value).toBe(false)
    expect(feed.isFetchingPreviousPage.value).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('collecting an entry mid-page clears every in-flight flag at once', async () => {
    const { calls, fetcher } = gatedFetcher(true)
    const inf = defineInfiniteQuery({
      id: 'mut-inf/collected-mid-page',
      key: () => ['feed'],
      fetcher,
      ...bidirectional,
      gcTime: 0,
    })
    const root = mount(inf)
    const { feed } = root.api
    calls[0]?.gate.resolve(page(0))
    await flushMicrotasks()
    const paging = feed.fetchNextPage().catch((e: unknown) => e)
    expect(feed.isFetchingNextPage.value).toBe(true)

    root.suspend()
    expect(feed.isFetching.value).toBe(false)
    expect(feed.isLoading.value).toBe(false)
    expect(feed.isFetchingNextPage.value).toBe(false)
    expect(feed.isFetchingPreviousPage.value).toBe(false)
    expect(isAbortError(await paging)).toBe(true)
    expect(feed.isFetching.value).toBe(false)
  })
})

describe('fetch events on the devtools bus', () => {
  test('failed and successful fetches of every kind report their start and settle', async () => {
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'mut-inf/fetch-events',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls += 1
        if (calls === 1 || pageParam === 1) throw new Error(`page ${pageParam} down`)
        return page(pageParam)
      },
      ...bidirectional,
    })
    const root = mount(inf)
    const fetches: string[] = []
    root.debug.subscribe((e) => {
      if (e.type.startsWith('cache:fetch')) fetches.push(e.type)
    })
    await root.waitForIdle() // the first load fails
    await root.api.feed.refetch()
    await root.api.feed.fetchNextPage().catch(() => {})
    await root.api.feed.fetchPreviousPage()
    expect(fetches).toEqual([
      'cache:fetch-error',
      'cache:fetch-start',
      'cache:fetch-success',
      'cache:fetch-start',
      'cache:fetch-error',
      'cache:fetch-start',
      'cache:fetch-success',
    ])
  })
})
