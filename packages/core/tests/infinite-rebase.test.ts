/**
 * Infinite-query optimistic snapshots rebase on a successful fetch, as `Entry` does
 * (SPEC §6.4). A rollback after a page fetch restores server truth, the fetched page
 * included, and drops only the optimistic delta.
 *
 * Also here: every `replace` path, app-side and plugin, regular and infinite, follows
 * one rule — it supersedes a fetch in flight only when it leaves the entry holding data.
 */
import { describe, expect, test } from 'vitest'
import { createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { definePlugin } from '../src/plugin/host'
import type { PluginHost } from '../src/plugin/types'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

type Page = { items: string[]; n: number }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Pages numbered by their param; `version` changes what a page-0 read returns. */
function pagedServer() {
  const server = { version: 'v1' }
  const feed = defineInfiniteQuery({
    id: `rebase/${Math.random()}`,
    key: () => ['feed'],
    fetcher: ({ pageParam }: { pageParam: number }) =>
      Promise.resolve<Page>({ items: [`${server.version}:${pageParam}`], n: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last: Page) => (last.n < 5 ? last.n + 1 : null),
    getPreviousPageParam: (first: Page) => (first.n > -5 ? first.n - 1 : null),
  })
  const root = createRoot(
    defineController((ctx) => ({ f: createQuery(ctx, feed) })),
    { queries: queryEngine(), deps: {} },
  )
  return { server, feed, root, handle: root.bindQuery(feed) }
}

const optimistic = (pages: Page[] | undefined): Page[] => {
  const [first, ...rest] = pages ?? []
  return [{ ...(first as Page), items: ['optimistic', ...(first as Page).items] }, ...rest]
}

describe('infinite optimistic snapshots rebase on page-fetch success', () => {
  test('a rollback after fetchNextPage keeps the appended page', async () => {
    const { root, handle } = pagedServer()
    await root.waitForIdle()
    const snap = handle.setData(optimistic)
    await root.api.f.fetchNextPage()
    expect(root.api.f.pages.value.map((p) => p.items)).toEqual([['optimistic', 'v1:0'], ['v1:1']])

    snap.rollback()
    expect(root.api.f.pages.value.map((p) => p.items)).toEqual([['v1:0'], ['v1:1']])
    // The params follow the pages, so the next page is page 2.
    await root.api.f.fetchNextPage()
    expect(root.api.f.pages.value.map((p) => p.n)).toEqual([0, 1, 2])
    root.dispose()
  })

  test('a rollback after fetchPreviousPage keeps the prepended page', async () => {
    const { root, handle } = pagedServer()
    await root.waitForIdle()
    const snap = handle.setData(optimistic)
    await root.api.f.fetchPreviousPage()
    snap.rollback()
    expect(root.api.f.pages.value.map((p) => p.items)).toEqual([['v1:-1'], ['v1:0']])
    await root.api.f.fetchPreviousPage()
    expect(root.api.f.pages.value.map((p) => p.n)).toEqual([-2, -1, 0])
    root.dispose()
  })

  test('a rollback after a refetch restores the refetched pages', async () => {
    const { server, root, handle } = pagedServer()
    await root.waitForIdle()
    await root.api.f.fetchNextPage()
    const snap = handle.setData(optimistic)
    server.version = 'v2'
    await root.api.f.refetch()
    snap.rollback()
    expect(root.api.f.pages.value.map((p) => p.items)).toEqual([['v2:0'], ['v2:1']])
    root.dispose()
  })

  test('stacked snapshots rolled back in any order end on server truth', async () => {
    const { root, handle } = pagedServer()
    await root.waitForIdle()
    const a = handle.setData(optimistic)
    const b = handle.setData(optimistic)
    await root.api.f.fetchNextPage()
    a.rollback()
    b.rollback()
    expect(root.api.f.pages.value.map((p) => p.items)).toEqual([['v1:0'], ['v1:1']])
    expect(root.api.f.hasPendingMutations.value).toBe(false)
    root.dispose()
  })
})

describe('one supersede rule for every replace', () => {
  function withHost() {
    let host: PluginHost | undefined
    const plugin = definePlugin({
      name: 'writer',
      setup: (h) => {
        host = h
      },
    })
    return { plugin, host: () => host as PluginHost }
  }

  test('host.queries.replace on an infinite entry leaves a fetch alone for empty pages', async () => {
    const pending = deferred<number[]>()
    let first = true
    const feed = defineInfiniteQuery({
      id: 'replace-rule/host-infinite',
      key: () => ['feed'],
      fetcher: () => {
        if (first) {
          first = false
          return Promise.resolve([1])
        }
        return pending.promise
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const { plugin, host } = withHost()
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {}, plugins: [plugin] },
    )
    await root.waitForIdle()
    void root.api.f.refetch()
    expect(root.api.f.isFetching.value).toBe(true)

    host().queries?.replace('replace-rule/host-infinite', ['feed'], [])
    expect(root.api.f.isFetching.value).toBe(true)
    pending.resolve([2])
    await flush()
    expect(root.api.f.pages.value).toEqual([[2]])

    const superseded = root.api.f.refetch()
    host().queries?.replace('replace-rule/host-infinite', ['feed'], [[3]])
    expect(root.api.f.isFetching.value).toBe(false)
    expect(root.api.f.pages.value).toEqual([[3]])
    await expect(superseded).resolves.toEqual([[3]])
    root.dispose()
  })

  test('the app-side infinite replace follows the same rule', async () => {
    const pending = deferred<number[]>()
    let first = true
    const feed = defineInfiniteQuery({
      id: 'replace-rule/app-infinite',
      key: () => ['feed'],
      fetcher: () => {
        if (first) {
          first = false
          return Promise.resolve([1])
        }
        return pending.promise
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    void root.api.f.refetch()
    root.bindQuery(feed).replace([])
    expect(root.api.f.isFetching.value).toBe(true)
    pending.resolve([2])
    await flush()
    expect(root.api.f.pages.value).toEqual([[2]])
    root.dispose()
  })

  test('host.queries.replace on a regular entry leaves a fetch alone for undefined', async () => {
    const pending = deferred<string>()
    let first = true
    const q = defineQuery({
      id: 'replace-rule/host-regular',
      key: () => ['k'],
      fetcher: () => {
        if (first) {
          first = false
          return Promise.resolve('v1')
        }
        return pending.promise
      },
    })
    const { plugin, host } = withHost()
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, plugins: [plugin] },
    )
    await root.waitForIdle()
    void root.api.s.refetch()
    host().queries?.replace('replace-rule/host-regular', ['k'], undefined)
    expect(root.api.s.isFetching.value).toBe(true)
    pending.resolve('v2')
    await flush()
    expect(root.api.s.data.value).toBe('v2')
    root.dispose()
  })
})
