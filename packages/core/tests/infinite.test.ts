import { describe, expect, test } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery } from '../src/query/define'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

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
    await flush()
    expect(root.chat.pages.value).toEqual([fx.pages[0]])
    expect(root.chat.flat.value).toEqual(['a', 'b'])
    expect(root.chat.status.value).toBe('success')
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
    await flush()
    expect(root.chat.flat.value).toEqual(['a', 'b'])

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
    await flush()
    expect(root.chat.flat.value).toEqual(['c', 'd'])
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
    await flush()
    await root.chat.fetchNextPage()
    await root.chat.fetchNextPage()
    expect(root.chat.pages.value.length).toBe(3)

    q.invalidate()
    await flush()
    expect(root.chat.pages.value.length).toBe(1)
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
    await flush()
    expect(root.x.pages.value).toEqual(['page0'])
    expect(root.x.flat.value).toEqual(['page0'])
    root.dispose()
  })
})
