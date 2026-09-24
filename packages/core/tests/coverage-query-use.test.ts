/**
 * `query/use.ts` paths the main suites leave dark: the neutral flags of a
 * disabled subscription (regular and infinite), imperative calls after
 * dispose, the one-promise `firstValue` cache across a key change, retention
 * with nothing to retain, a key thunk that re-runs to the same key, a
 * subscription created while its controller is suspended, resume re-checks,
 * and the infinite subscription's `reset`, `refetch`, `data` and `isLoading`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type ActivityEvent,
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  definePlugin,
  defineQuery,
  isAbortError,
  queryEngine,
  signal,
} from '../src'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
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

type Page = { n: number; items: string[] }
const page = (n: number): Page => ({ n, items: [`i${n}`] })
const paging = {
  initialPageParam: 0,
  getNextPageParam: (p: Page) => (p.n < 2 ? p.n + 1 : null),
  getPreviousPageParam: (p: Page) => (p.n > -1 ? p.n - 1 : null),
  itemsOf: (p: Page) => p.items,
}

/** Records entry activity so a test can count acquires and releases. */
function activityRecorder() {
  const activity: Array<{ kind: 'on' | 'off'; e: ActivityEvent }> = []
  const plugin = definePlugin({
    name: 'activity',
    setup: () => ({
      onActivate: (e) => activity.push({ kind: 'on', e }),
      onDeactivate: (e) => activity.push({ kind: 'off', e }),
    }),
  })
  return { plugin, activity }
}

describe('a disabled subscription', () => {
  test('reports neutral flags: nothing fetching, stale, no pending writes, not paused', () => {
    const q = defineQuery({ id: 'cov-use/disabled', key: () => ['k'], fetcher: async () => 1 })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q, { enabled: () => false }) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const { s } = root.api
    expect(s.isEnabled.value).toBe(false)
    expect(s.status.value).toBe('idle')
    expect(s.isLoading.value).toBe(false)
    expect(s.isFetching.value).toBe(false)
    expect(s.isStale.value).toBe(true)
    expect(s.hasPendingMutations.value).toBe(false)
    expect(s.isPaused.value).toBe(false)
    expect(s.lastUpdatedAt.value).toBeUndefined()
  })

  test('infinite: reports the same flags plus closed paging', () => {
    const inf = defineInfiniteQuery({
      id: 'cov-use/disabled-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      ...paging,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf, { enabled: () => false }) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const { feed } = root.api
    expect(feed.isEnabled.value).toBe(false)
    expect(feed.data.value).toBeUndefined()
    expect(feed.pages.value).toEqual([])
    expect(feed.flat.value).toEqual([])
    expect(feed.isLoading.value).toBe(false)
    expect(feed.isFetching.value).toBe(false)
    expect(feed.isStale.value).toBe(true)
    expect(feed.hasPendingMutations.value).toBe(false)
    expect(feed.isPaused.value).toBe(false)
    expect(feed.lastUpdatedAt.value).toBeUndefined()
    expect(feed.hasNextPage.value).toBe(false)
    expect(feed.hasPreviousPage.value).toBe(false)
    expect(feed.isFetchingNextPage.value).toBe(false)
    expect(feed.isFetchingPreviousPage.value).toBe(false)
  })
})

describe('after dispose', () => {
  test('refetch rejects with an AbortError, regular and infinite', async () => {
    const q = defineQuery({
      id: 'cov-use/refetch-disposed',
      key: () => ['k'],
      fetcher: async () => 1,
    })
    const inf = defineInfiniteQuery({
      id: 'cov-use/refetch-disposed-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      ...paging,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q), feed: createQuery(ctx, inf) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    const { s, feed } = root.api
    root.dispose()
    expect(isAbortError(await s.refetch().catch((e: unknown) => e))).toBe(true)
    expect(isAbortError(await feed.refetch().catch((e: unknown) => e))).toBe(true)
  })
})

describe('firstValue across a key change', () => {
  test('the settling promise of a replaced entry does not evict the newer one', async () => {
    const gates = new Map<string, Deferred<string>>()
    const q = defineQuery({
      id: 'cov-use/first-value-cache',
      key: (k: string) => [k],
      fetcher: (_c, k: string) => {
        const d = deferred<string>()
        gates.set(k, d)
        return d.promise
      },
    })
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const k = signal('a')
          return { k, s: createQuery(ctx, q, () => [k.value]) }
        }),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const { s, k } = root.api
    const forA = s.firstValue()
    k.set('b')
    const forB = s.firstValue()
    expect(forB).not.toBe(forA)

    gates.get('a')?.resolve('A')
    expect(await forA).toBe('A')
    expect(s.firstValue()).toBe(forB) // still the pending promise for `b`
    gates.get('b')?.resolve('B')
    expect(await forB).toBe('B')
  })
})

describe('retention with nothing to retain', () => {
  test('keepPreviousData across a key change before any data arrived shows loading', async () => {
    const gates: Array<Deferred<string>> = []
    const q = defineQuery({
      id: 'cov-use/keep-prev-empty',
      key: (k: string) => [k],
      fetcher: () => {
        const d = deferred<string>()
        gates.push(d)
        return d.promise
      },
      keepPreviousData: true,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const k = signal('a')
          return { k, s: createQuery(ctx, q, () => [k.value]) }
        }),
        { queries: queryEngine(), deps: {} },
      ),
    )
    root.api.k.set('b')
    expect(root.api.s.data.value).toBeUndefined()
    expect(root.api.s.isLoading.value).toBe(true)
    gates[1]?.resolve('B')
    await flush()
    expect(root.api.s.data.value).toBe('B')
  })

  test('infinite: keepPreviousData across a key change before any page arrived shows loading', async () => {
    const gates: Array<Deferred<Page>> = []
    const inf = defineInfiniteQuery({
      id: 'cov-use/keep-prev-empty-inf',
      key: (k: string) => [k],
      fetcher: () => {
        const d = deferred<Page>()
        gates.push(d)
        return d.promise
      },
      ...paging,
      keepPreviousData: true,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const k = signal('a')
          return { k, feed: createQuery(ctx, inf, () => [k.value]) }
        }),
        { queries: queryEngine(), deps: {} },
      ),
    )
    root.api.k.set('b')
    expect(root.api.feed.pages.value).toEqual([])
    expect(root.api.feed.isLoading.value).toBe(true)
    gates[1]?.resolve(page(0))
    await flush()
    expect(root.api.feed.pages.value).toEqual([page(0)])
  })

  test('keepDataWhileDisabled with nothing loaded yet reports no data, regular and infinite', async () => {
    const q = defineQuery({
      id: 'cov-use/keep-disabled-empty',
      key: () => ['k'],
      fetcher: () => new Promise<string>(() => {}),
    })
    const inf = defineInfiniteQuery({
      id: 'cov-use/keep-disabled-empty-inf',
      key: () => ['feed'],
      fetcher: () => new Promise<Page>(() => {}),
      ...paging,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const on = signal(true)
          const opts = { enabled: () => on.value, keepDataWhileDisabled: true }
          return { on, s: createQuery(ctx, q, opts), feed: createQuery(ctx, inf, opts) }
        }),
        { queries: queryEngine(), deps: {} },
      ),
    )
    expect(root.api.s.isFetching.value).toBe(true)
    root.api.on.set(false)
    expect(root.api.s.data.value).toBeUndefined()
    expect(root.api.s.status.value).toBe('idle')
    expect(root.api.feed.data.value).toBeUndefined()
    expect(root.api.feed.pages.value).toEqual([])
  })
})

describe('a key thunk that re-runs to the same key', () => {
  test('keeps the bound entry and does not refetch, regular and infinite', async () => {
    const fetcher = vi.fn(async (_c: unknown, bucket: number) => `bucket-${bucket}`)
    const q = defineQuery({ id: 'cov-use/same-key', key: (b: number) => [b], fetcher })
    const infFetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'cov-use/same-key-inf',
      key: (b: number) => [b],
      fetcher: infFetcher,
      ...paging,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const n = signal(1)
          const bucket = () => [Math.floor(n.value / 10)] as [number]
          return { n, s: createQuery(ctx, q, bucket), feed: createQuery(ctx, inf, bucket) }
        }),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    root.api.n.set(2) // same bucket, so the thunks re-run to an identical key
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(infFetcher).toHaveBeenCalledTimes(1)
    expect(root.api.s.data.value).toBe('bucket-0')
    expect(root.api.s.lastUpdatedAt.value).toEqual(expect.any(Number))
    expect(root.api.feed.lastUpdatedAt.value).toEqual(expect.any(Number))
  })
})

describe('suspend and resume', () => {
  test('a subscription created while its controller is suspended is acquired once', async () => {
    const { plugin, activity } = activityRecorder()
    const q = defineQuery({
      id: 'cov-use/created-suspended',
      key: () => ['k'],
      fetcher: async () => 1,
    })
    const inf = defineInfiniteQuery({
      id: 'cov-use/created-suspended-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      ...paging,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          load: () => ({ s: createQuery(ctx, q), feed: createQuery(ctx, inf) }),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    root.suspend()
    const subs = root.api.load() // subscribes at once, although the tree is suspended
    await root.waitForIdle()
    expect(subs.s.data.value).toBe(1)
    root.resume() // must not acquire the entries a second time
    expect(activity.filter((a) => a.kind === 'on')).toHaveLength(2)

    root.suspend() // one release takes each entry to zero subscribers
    expect(activity.filter((a) => a.kind === 'off').map((a) => a.e.query.id)).toEqual(
      expect.arrayContaining(['cov-use/created-suspended', 'cov-use/created-suspended-inf']),
    )
  })

  test('resume re-reads an enabled thunk and rebinds when it is true', async () => {
    const fetcher = vi.fn(async () => 'v')
    const q = defineQuery({ id: 'cov-use/resume-enabled', key: () => ['k'], fetcher })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q, { enabled: () => true }) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    root.suspend()
    root.resume() // stale (staleTime 0), so it refetches
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(root.api.s.isEnabled.value).toBe(true)
  })

  test('resume refetches an entry that failed over fresh data, and absorbs a second failure', async () => {
    let fail = false
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('down')
      return 'v'
    })
    const q = defineQuery({
      id: 'cov-use/resume-error',
      key: () => ['k'],
      fetcher,
      staleTime: 60_000,
    })
    const infFetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => {
      if (fail) throw new Error('down')
      return page(pageParam)
    })
    const inf = defineInfiniteQuery({
      id: 'cov-use/resume-error-inf',
      key: () => ['feed'],
      fetcher: infFetcher,
      ...paging,
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q), feed: createQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    fail = true
    await expect(root.api.s.refetch()).rejects.toThrow('down')
    await expect(root.api.feed.refetch()).rejects.toThrow('down')
    expect(root.api.s.status.value).toBe('error')
    expect(root.api.feed.status.value).toBe('error')

    // Fresh by staleTime, but in error: resume retries both.
    root.suspend()
    root.resume()
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(infFetcher).toHaveBeenCalledTimes(3)
    expect(root.api.s.status.value).toBe('error')
    expect(root.api.s.data.value).toBe('v')
    expect(root.api.feed.pages.value).toEqual([page(0)])
  })
})

describe('infinite subscription surface', () => {
  test('reset returns a failed first load to idle', async () => {
    const inf = defineInfiniteQuery({
      id: 'cov-use/inf-reset',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        throw new Error('down')
      },
      ...paging,
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
    expect(root.api.feed.status.value).toBe('error')
    root.api.feed.reset()
    expect(root.api.feed.status.value).toBe('idle')
    expect(root.api.feed.error.value).toBeUndefined()
  })

  test('refetch resolves with the pages, and data reads them', async () => {
    const inf = defineInfiniteQuery({
      id: 'cov-use/inf-refetch',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      ...paging,
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
    expect(root.api.feed.data.value).toEqual([page(0)])
    expect(await root.api.feed.refetch()).toEqual([page(0)])
  })

  test('cancel stops the fetch in flight and settles back to idle', async () => {
    const gates: Array<Deferred<Page>> = []
    const inf = defineInfiniteQuery({
      id: 'cov-use/inf-cancel',
      key: () => ['feed'],
      fetcher: () => {
        const d = deferred<Page>()
        gates.push(d)
        return d.promise
      },
      ...paging,
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
    expect(feed.isFetching.value).toBe(true)
    feed.cancel()
    expect(feed.isFetching.value).toBe(false)
    expect(feed.status.value).toBe('idle')
    gates[0]?.resolve(page(0)) // too late: the cancel superseded it
    await flush()
    expect(feed.pages.value).toEqual([])
  })

  test('isLoading stays false while retained pages show during a key change', async () => {
    const gates: Array<Deferred<Page>> = []
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-use/inf-retained-loading',
      key: (k: string) => [k],
      fetcher: ({ pageParam }: { pageParam: number }) => {
        calls += 1
        if (calls === 1) return Promise.resolve(page(pageParam))
        const d = deferred<Page>()
        gates.push(d)
        return d.promise
      },
      ...paging,
      keepPreviousData: true,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const k = signal('a')
          return { k, feed: createQuery(ctx, inf, () => [k.value]) }
        }),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    root.api.k.set('b')
    const { feed } = root.api
    expect(feed.isFetching.value).toBe(true)
    expect(feed.isLoading.value).toBe(false)
    expect(feed.data.value).toEqual([page(0)])
    expect(feed.flat.value).toEqual(['i0'])
    gates[0]?.resolve(page(0))
    await flush()
    expect(feed.isFetching.value).toBe(false)
  })
})
