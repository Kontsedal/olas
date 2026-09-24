// @vitest-environment jsdom
/**
 * Browser-trigger paths of the query engine: the shared focus / visibility /
 * reconnect listeners in `query/focus-online.ts`, the focus refetch of regular
 * and infinite entries, the hidden-tab interval skip, and the offline
 * deferral and park paths of `Entry` and `InfiniteEntry`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  isAbortError,
  queryEngine,
} from '../src'
import { __resetFocusOnlineForTests } from '../src/query/focus-online'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
})
const keep = <T extends { dispose(): void }>(r: T): T => {
  roots.push(r)
  return r
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

const setOnline = (v: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
}
const setVisibility = (v: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
}
const focus = (): void => {
  window.dispatchEvent(new Event('focus'))
}
const reconnect = (): void => {
  setOnline(true)
  window.dispatchEvent(new Event('online'))
}

describe('shared focus, visibility and reconnect listeners', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  test('two focus subscribers share the listener; releasing one keeps the other live', async () => {
    let a = 0
    let b = 0
    const qa = defineQuery({
      id: 'cov-focus/share-a',
      key: () => ['a'],
      fetcher: async () => ++a,
      refetchOnWindowFocus: true,
    })
    const qb = defineQuery({
      id: 'cov-focus/share-b',
      key: () => ['b'],
      fetcher: async () => ++b,
      refetchOnWindowFocus: true,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, qb) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          s: createQuery(ctx, qa),
          open: () => ctx.attach(child, undefined),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const opened = root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect([a, b]).toEqual([1, 1])

    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect([a, b]).toEqual([2, 2])

    opened.dispose()
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect([a, b]).toEqual([3, 2])
  })

  test('a visibilitychange to hidden does not refetch; back to visible does', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'cov-focus/visibility',
      key: () => ['v'],
      fetcher: async () => ++calls,
      refetchOnWindowFocus: true,
    })
    keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
  })

  test('two reconnect subscribers share the listener; releasing one keeps the other live', async () => {
    let a = 0
    let b = 0
    const qa = defineQuery({
      id: 'cov-focus/reconnect-a',
      key: () => ['a'],
      fetcher: async () => ++a,
      refetchOnReconnect: true,
    })
    const qb = defineQuery({
      id: 'cov-focus/reconnect-b',
      key: () => ['b'],
      fetcher: async () => ++b,
      refetchOnReconnect: true,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, qb) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          s: createQuery(ctx, qa),
          open: () => ctx.attach(child, undefined),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const opened = root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect([a, b]).toEqual([2, 2])

    opened.dispose()
    reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect([a, b]).toEqual([3, 2])
  })

  test('the test reset detaches the listeners even while subscribers remain', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'cov-focus/reset',
      key: () => ['r'],
      fetcher: async () => ++calls,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    const first = root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    __resetFocusOnlineForTests()
    focus()
    reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    // Releasing the stranded subscription is harmless, and a fresh one
    // installs the listeners again.
    first.dispose()
    root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(3)
  })
})

describe('focus refetch of regular entries', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a focus while the fetch is in flight joins it', async () => {
    const gates: Array<Deferred<number>> = []
    const q = defineQuery({
      id: 'cov-focus/join',
      key: () => ['j'],
      fetcher: () => {
        const d = deferred<number>()
        gates.push(d)
        return d.promise
      },
      refetchOnWindowFocus: true,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    expect(root.api.s.isFetching.value).toBe(true)
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(gates).toHaveLength(1)
    gates[0]?.resolve(7)
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.s.data.value).toBe(7)
  })

  test('a failing focus refetch settles the entry in error', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'cov-focus/fail',
      key: () => ['f'],
      fetcher: async () => {
        calls += 1
        if (calls > 1) throw new Error('refocus failed')
        return 'ok'
      },
      refetchOnWindowFocus: true,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.s.status.value).toBe('error')
    expect((root.api.s.error.value as Error).message).toBe('refocus failed')
    expect(root.api.s.data.value).toBe('ok')
  })
})

describe('focus refetch of infinite entries', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('fresh pages ignore focus; an in-flight fetch is joined; stale pages refetch', async () => {
    const gates: Array<Deferred<Page>> = []
    const inf = defineInfiniteQuery({
      id: 'cov-focus/inf',
      key: () => ['feed'],
      fetcher: ({ pageParam }: { pageParam: number }) => {
        const d = deferred<Page>()
        gates.push(d)
        return d.promise.then(() => page(pageParam))
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 1_000,
      refetchOnWindowFocus: true,
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
    // In flight: the focus joins the running first-page fetch.
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(gates).toHaveLength(1)
    gates[0]?.resolve(page(0))
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.feed.pages.value).toEqual([page(0)])

    // Fresh: within staleTime, no refetch.
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(gates).toHaveLength(1)

    // Stale: refetches.
    await vi.advanceTimersByTimeAsync(1_000)
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(gates).toHaveLength(2)
  })

  test('a failing focus refetch settles the infinite entry in error and keeps its pages', async () => {
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-focus/inf-fail',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls += 1
        if (calls > 1) throw new Error('refocus failed')
        return page(pageParam)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchOnWindowFocus: true,
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
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.feed.status.value).toBe('error')
    expect(root.api.feed.pages.value).toEqual([page(0)])
  })
})

describe('infinite refetchInterval in a hidden tab', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  test('ticks skip while hidden and resume polling once visible', async () => {
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-focus/inf-hidden',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls += 1
        return page(pageParam)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchInterval: 100,
    })
    keep(
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
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toBe(1)
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(2)
  })
})

describe('offline deferral of regular entries', () => {
  afterEach(() => setOnline(true))

  test('a second deferral while offline shares the wait; one fetch on reconnect serves both', async () => {
    setOnline(false)
    const fetcher = vi.fn(async () => 'fresh')
    const q = defineQuery({ id: 'cov-focus/defer-twice', key: () => ['k'], fetcher })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    expect(root.api.s.isPaused.value).toBe(true)
    const again = root.api.s.refetch()
    expect(fetcher).not.toHaveBeenCalled()

    reconnect()
    expect(await again).toBe('fresh')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(root.api.s.isPaused.value).toBe(false)
  })

  test('a reconnect fetch that fails rejects the deferred caller', async () => {
    setOnline(false)
    const q = defineQuery({
      id: 'cov-focus/defer-fail',
      key: () => ['k'],
      fetcher: async (): Promise<string> => {
        throw new Error('still down')
      },
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    const deferredRefetch = root.api.s.refetch()
    reconnect()
    await expect(deferredRefetch).rejects.toThrow('still down')
    expect(root.api.s.status.value).toBe('error')
  })

  test('disposing while a fetch is deferred rejects it with an AbortError; reconnect then fetches nothing', async () => {
    setOnline(false)
    const fetcher = vi.fn(async () => 'fresh')
    const q = defineQuery({ id: 'cov-focus/defer-dispose', key: () => ['k'], fetcher })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    const deferredRefetch = root.api.s.refetch().catch((e: unknown) => e)
    root.dispose()
    expect(isAbortError(await deferredRefetch)).toBe(true)
    reconnect()
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('offlineFirst: a network failure over loaded data parks at success, keeping the data', async () => {
    let offlineFailure = false
    const q = defineQuery({
      id: 'cov-focus/offline-first-data',
      key: () => ['k'],
      fetcher: async () => {
        if (offlineFailure) {
          offlineFailure = false
          throw new TypeError('Failed to fetch')
        }
        return 'v'
      },
      networkMode: 'offlineFirst',
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await root.waitForIdle()
    setOnline(false)
    offlineFailure = true
    const parked = root.api.s.refetch()
    await vi.waitFor(() => expect(root.api.s.isPaused.value).toBe(true))
    expect(root.api.s.status.value).toBe('success')
    expect(root.api.s.data.value).toBe('v')
    expect(root.api.s.error.value).toBeUndefined()
    reconnect()
    expect(await parked).toBe('v')
    expect(root.api.s.isPaused.value).toBe(false)
  })
})

describe('offline deferral of infinite entries', () => {
  afterEach(() => setOnline(true))

  type Bi = { n: number }
  const defineBi = (id: string, fetcher: (n: number) => Promise<Bi>, extra: object = {}) =>
    defineInfiniteQuery({
      id,
      key: () => ['bi'],
      fetcher: ({ pageParam }: { pageParam: number }) => fetcher(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Bi) => (p.n < 2 ? p.n + 1 : null),
      getPreviousPageParam: (p: Bi) => (p.n > -2 ? p.n - 1 : null),
      ...extra,
    })

  test('the first page defers while offline and loads on reconnect', async () => {
    setOnline(false)
    const fetcher = vi.fn(async (n: number) => ({ n }))
    const inf = defineBi('cov-focus/inf-defer-initial', fetcher)
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    expect(root.api.feed.isPaused.value).toBe(true)
    expect(root.api.feed.status.value).toBe('idle')
    expect(fetcher).not.toHaveBeenCalled()
    reconnect()
    await vi.waitFor(() => expect(root.api.feed.pages.value).toEqual([{ n: 0 }]))
    expect(root.api.feed.isPaused.value).toBe(false)
  })

  test('next and previous pages requested offline both run on reconnect, previous first', async () => {
    const order: number[] = []
    const inf = defineBi('cov-focus/inf-defer-both', async (n) => {
      order.push(n)
      return { n }
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
    setOnline(false)
    const next = root.api.feed.fetchNextPage()
    const prev = root.api.feed.fetchPreviousPage()
    expect(root.api.feed.isPaused.value).toBe(true)
    expect(order).toEqual([0])

    reconnect()
    await Promise.all([next, prev])
    expect(order).toEqual([0, -1, 1])
    expect(root.api.feed.pages.value).toEqual([{ n: -1 }, { n: 0 }, { n: 1 }])
  })

  test('a deferred next page that fails on reconnect rejects its caller', async () => {
    let fail = false
    const inf = defineBi('cov-focus/inf-defer-fail', async (n) => {
      if (fail) throw new Error('page failed')
      return { n }
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
    setOnline(false)
    const next = root.api.feed.fetchNextPage()
    fail = true
    reconnect()
    await expect(next).rejects.toThrow('page failed')
    expect(root.api.feed.pages.value).toEqual([{ n: 0 }])
  })

  test('offlineFirst: a previous page failing offline parks, then prepends on reconnect', async () => {
    let failPrev = false
    const inf = defineBi(
      'cov-focus/inf-park-prev',
      async (n) => {
        if (failPrev && n < 0) {
          failPrev = false
          throw new TypeError('Failed to fetch')
        }
        return { n }
      },
      { networkMode: 'offlineFirst' },
    )
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
    setOnline(false)
    failPrev = true
    const prev = root.api.feed.fetchPreviousPage()
    await vi.waitFor(() => expect(root.api.feed.isPaused.value).toBe(true))
    expect(root.api.feed.isFetchingPreviousPage.value).toBe(false)
    expect(root.api.feed.pages.value).toEqual([{ n: 0 }])
    reconnect()
    await prev
    await vi.waitFor(() => expect(root.api.feed.pages.value).toEqual([{ n: -1 }, { n: 0 }]))
  })

  test('disposing while pages are deferred rejects the waiting caller with an AbortError', async () => {
    setOnline(false)
    const fetcher = vi.fn(async (n: number) => ({ n }))
    const inf = defineBi('cov-focus/inf-defer-dispose', fetcher)
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    const next = root.api.feed.fetchNextPage().catch((e: unknown) => e)
    root.dispose()
    expect(isAbortError(await next)).toBe(true)
    reconnect()
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
