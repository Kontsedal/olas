import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery } from '../src/query/define'
import { signal } from '../src/signals'

const emptyDeps = {}

type Page = { items: string[]; next: number | null; prev: number | null }

const makeFixture = () => {
  const pages: Record<number, Page> = {
    0: { items: ['a', 'b'], next: 1, prev: null },
    1: { items: ['c', 'd'], next: 2, prev: 0 },
    2: { items: ['e', 'f'], next: null, prev: 1 },
  }
  const calls: number[] = []
  return {
    pages,
    calls,
    fetch: async ({ pageParam }: { pageParam: number; signal: AbortSignal }) => {
      calls.push(pageParam)
      const page = pages[pageParam]
      if (!page) throw new Error(`no page ${pageParam}`)
      return page
    },
  }
}

describe('defineInfiniteQuery + ctx.use', () => {
  test('initial fetch lands the first page; data exposes it', async () => {
    const fx = makeFixture()
    const q = defineInfiniteQuery({
      key: () => ['chat'],
      fetcher: fx.fetch,
      initialPageParam: 0,
      getNextPageParam: (page) => page.next,
      getPreviousPageParam: (page) => page.prev,
      itemsOf: (page) => page.items,
    })
    const def = defineController((ctx) => ({ chat: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.chat.status.value).toBe('success'))
    expect(root.chat.pages.value).toEqual([fx.pages[0]])
    expect(root.chat.flat.value).toEqual(['a', 'b'])
    expect(root.chat.hasNextPage.value).toBe(true)
    expect(root.chat.hasPreviousPage.value).toBe(false)
    root.dispose()
  })

  test('fetchNextPage appends pages; hasNextPage flips to false at the end', async () => {
    const fx = makeFixture()
    const q = defineInfiniteQuery({
      key: () => ['chat'],
      fetcher: fx.fetch,
      initialPageParam: 0,
      getNextPageParam: (page) => page.next,
      itemsOf: (page) => page.items,
    })
    const def = defineController((ctx) => ({ chat: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.chat.flat.value).toEqual(['a', 'b']))

    await root.chat.fetchNextPage()
    expect(root.chat.flat.value).toEqual(['a', 'b', 'c', 'd'])
    expect(root.chat.hasNextPage.value).toBe(true)

    await root.chat.fetchNextPage()
    expect(root.chat.flat.value).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(root.chat.hasNextPage.value).toBe(false)
    root.dispose()
  })

  test('fetchPreviousPage prepends pages', async () => {
    const fx = makeFixture()
    const q = defineInfiniteQuery({
      key: () => ['chat'],
      fetcher: fx.fetch,
      initialPageParam: 1, // start in the middle
      getNextPageParam: (page) => page.next,
      getPreviousPageParam: (page) => page.prev,
      itemsOf: (page) => page.items,
    })
    const def = defineController((ctx) => ({ chat: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.chat.flat.value).toEqual(['c', 'd']))
    expect(root.chat.hasPreviousPage.value).toBe(true)

    await root.chat.fetchPreviousPage()
    expect(root.chat.flat.value).toEqual(['a', 'b', 'c', 'd'])
    expect(root.chat.hasPreviousPage.value).toBe(false)
    root.dispose()
  })

  test('invalidate drops accumulated pages and refetches from initialPageParam', async () => {
    const fx = makeFixture()
    const q = defineInfiniteQuery({
      key: () => ['chat'],
      fetcher: fx.fetch,
      initialPageParam: 0,
      getNextPageParam: (page) => page.next,
      itemsOf: (page) => page.items,
    })
    const def = defineController((ctx) => ({ chat: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.chat.pages.value.length).toBe(1))
    await root.chat.fetchNextPage()
    await root.chat.fetchNextPage()
    expect(root.chat.pages.value.length).toBe(3)

    q.invalidate()
    await vi.waitFor(() => expect(root.chat.pages.value.length).toBe(1))
    expect(root.chat.pages.value[0]).toEqual(fx.pages[0])
    root.dispose()
  })

  test('flat falls back to pages when itemsOf is omitted', async () => {
    const q = defineInfiniteQuery({
      key: () => ['raw'],
      fetcher: async ({ pageParam }) => `page${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: (page) => (page === 'page0' ? 1 : null),
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['page0']))
    expect(root.x.flat.value).toEqual(['page0'])
    root.dispose()
  })
})

describe('infinite query: refetchInterval', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('refetches periodically while subscribed', async () => {
    // Regression: refetchInterval was declared in InfiniteQuerySpec but never
    // wired in InfiniteClientEntry — periodic refetch silently did nothing.
    let count = 0
    const q = defineInfiniteQuery({
      key: () => ['rfi-infinite'],
      fetcher: async () => `page${++count}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchInterval: 1000,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(3)
    root.dispose()
  })
})

describe('infinite query: keepPreviousData', () => {
  test('previous pages remain visible until the new key resolves', async () => {
    // Regression: keepPreviousData was declared in InfiniteQuerySpec but
    // InfiniteSubscriptionImpl ignored it. Page-keyed infinite queries
    // would flash an empty pages array on key change.
    const dKey1 = (() => {
      let res: (v: string) => void = () => {}
      return {
        promise: new Promise<string>((r) => {
          res = r
        }),
        resolve: () => res('first-key'),
      }
    })()
    const dKey2 = (() => {
      let res: (v: string) => void = () => {}
      return {
        promise: new Promise<string>((r) => {
          res = r
        }),
        resolve: () => res('second-key'),
      }
    })()

    const q = defineInfiniteQuery({
      key: (k: number) => [k],
      fetcher: async (_, k: number) => (k === 1 ? dKey1.promise : dKey2.promise),
      initialPageParam: 0,
      getNextPageParam: () => null,
      keepPreviousData: true,
    })
    const keySig = signal<[number]>([1])
    const def = defineController((ctx) => ({
      x: ctx.use(q, () => keySig.value),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    dKey1.resolve()
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['first-key']))

    // Switch to key 2; the new fetch hasn't resolved yet — pages still expose
    // the previous key's data because keepPreviousData is on.
    keySig.set([2])
    await Promise.resolve()
    expect(root.x.pages.value).toEqual(['first-key'])

    dKey2.resolve()
    await vi.waitFor(() => expect(root.x.pages.value).toEqual(['second-key']))
    root.dispose()
  })
})
