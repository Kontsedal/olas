// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createQuery, definePlugin, type WriteEvent } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

const emptyDeps = {}

type Page = { items: number[]; next: number | null }

/** Pages of two items; page `n` holds `[2n, 2n + 1]`, and there are three. */
const page = (n: number): Page => ({ items: [2 * n, 2 * n + 1], next: n < 2 ? n + 1 : null })

const defineChat = (id: string, fetcher: (n: number) => Promise<Page>, extra: object = {}) =>
  defineInfiniteQuery({
    id,
    key: () => ['chat'],
    fetcher: ({ pageParam }) => fetcher(pageParam),
    initialPageParam: 0,
    getNextPageParam: (p: Page) => p.next,
    itemsOf: (p: Page) => p.items,
    ...extra,
  })

describe('infinite queries dehydrate and hydrate', () => {
  test('the server payload carries pages and params; the client seeds them and pages on', async () => {
    const serverCalls: number[] = []
    const serverQ = defineChat('parity/ssr', async (n) => {
      serverCalls.push(n)
      return page(n)
    })
    const server = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, serverQ) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await server.waitForIdle()
    await server.api.chat.fetchNextPage()
    const state = server.dehydrate()
    server.dispose()
    const entry = state.entries.find((e) => e.id === 'parity/ssr')
    expect(entry?.data).toEqual([page(0), page(1)])
    expect(entry?.pageParams).toEqual([0, 1])

    const clientCalls: number[] = []
    const clientQ = defineChat(
      'parity/ssr',
      async (n) => {
        clientCalls.push(n)
        return page(n)
      },
      { staleTime: 60_000 },
    )
    const client = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, clientQ) })),
      { queries: queryEngine(), deps: emptyDeps, hydrate: JSON.parse(JSON.stringify(state)) },
    )
    // Seeded from the payload: no refetch of the loaded pages.
    expect(client.api.chat.status.value).toBe('success')
    expect(client.api.chat.flat.value).toEqual([0, 1, 2, 3])
    expect(client.api.chat.hasNextPage.value).toBe(true)
    await client.waitForIdle()
    expect(clientCalls).toEqual([])
    // Paging continues from the hydrated params.
    await client.api.chat.fetchNextPage()
    expect(clientCalls).toEqual([2])
    expect(client.api.chat.flat.value).toEqual([0, 1, 2, 3, 4, 5])
    client.dispose()
  })

  test('root.hydrate on a bound entry supersedes its fetch and reports one hydrate write', async () => {
    const writes: WriteEvent[] = []
    const recorder = definePlugin({
      name: 'recorder',
      setup: () => ({ onWrite: (e) => writes.push(e) }),
    })
    let release: (p: Page) => void = () => {}
    const q = defineChat(
      'parity/late-hydrate',
      () =>
        new Promise<Page>((resolve) => {
          release = resolve
        }),
    )
    const root = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps, plugins: [recorder] },
    )
    expect(root.api.chat.isFetching.value).toBe(true)
    root.hydrate({
      version: 1,
      entries: [
        {
          id: 'parity/late-hydrate',
          key: ['chat'],
          data: [page(0)],
          pageParams: [0],
          lastUpdatedAt: Date.now(),
        },
      ],
    })
    expect(root.api.chat.isFetching.value).toBe(false)
    expect(root.api.chat.flat.value).toEqual([0, 1])
    release({ items: [99], next: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(root.api.chat.flat.value).toEqual([0, 1]) // the superseded fetch did not land
    expect(writes.map((w) => w.source)).toEqual(['hydrate'])
    expect(writes[0]?.pageParams).toEqual([0])
    root.dispose()
  })

  test('a payload without aligned params cannot seed an infinite entry', async () => {
    let calls = 0
    const q = defineChat('parity/bad-payload', async (n) => {
      calls += 1
      return page(n)
    })
    const root = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: emptyDeps,
        hydrate: {
          version: 1,
          entries: [{ id: 'parity/bad-payload', key: ['chat'], data: 'x', lastUpdatedAt: 1 }],
        },
      },
    )
    await root.waitForIdle()
    expect(calls).toBe(1) // ignored the payload, fetched for itself
    expect(root.api.chat.flat.value).toEqual([0, 1])
    root.dispose()
  })
})

describe('infinite queries refetch on focus and reconnect', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a stale entry re-fetches every loaded page on focus; the flag off leaves it alone', async () => {
    const calls: number[] = []
    const q = defineChat(
      'parity/focus',
      async (n) => {
        calls.push(n)
        return page(n)
      },
      { refetchOnWindowFocus: true },
    )
    const off = defineChat('parity/focus-off', async (n) => page(n))
    const root = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, q), quiet: createQuery(ctx, off) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    await root.api.chat.fetchNextPage()
    expect(calls).toEqual([0, 1])
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([0, 1, 0, 1])
    root.dispose()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([0, 1, 0, 1]) // released on dispose
  })

  test('the root default applies to infinite queries too', async () => {
    let calls = 0
    const q = defineChat('parity/reconnect', async (n) => {
      calls += 1
      return page(n)
    })
    const root = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, q) })),
      { queries: queryEngine({ defaults: { refetchOnReconnect: true } }), deps: emptyDeps },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
    root.dispose()
  })
})

describe('infinite queries park offline in offlineFirst mode', () => {
  const setOnline = (v: boolean): void => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
  }
  afterEach(() => setOnline(true))

  test('a network failure while offline parks the first page; reconnect resumes', async () => {
    setOnline(false)
    let attempt = 0
    const q = defineChat(
      'parity/offline-first',
      async (n) => {
        attempt += 1
        if (attempt === 1) throw new TypeError('Failed to fetch')
        return page(n)
      },
      { networkMode: 'offlineFirst' },
    )
    const root = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await vi.waitFor(() => expect(root.api.chat.isPaused.value).toBe(true))
    expect(root.api.chat.status.value).toBe('idle')
    expect(root.api.chat.error.value).toBeUndefined()
    expect(root.api.chat.isFetching.value).toBe(false)

    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(root.api.chat.flat.value).toEqual([0, 1]))
    expect(root.api.chat.isPaused.value).toBe(false)
    expect(root.api.chat.status.value).toBe('success')
    root.dispose()
  })

  test('fetchNextPage failing offline parks, keeps the loaded pages, and resumes', async () => {
    let failNext = false
    const q = defineChat(
      'parity/offline-next',
      async (n) => {
        if (failNext) {
          failNext = false
          throw new TypeError('Failed to fetch')
        }
        return page(n)
      },
      { networkMode: 'offlineFirst' },
    )
    const root = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await root.waitForIdle()
    setOnline(false)
    failNext = true
    const paging = root.api.chat.fetchNextPage()
    await vi.waitFor(() => expect(root.api.chat.isPaused.value).toBe(true))
    expect(root.api.chat.flat.value).toEqual([0, 1])
    expect(root.api.chat.isFetchingNextPage.value).toBe(false)
    expect(root.api.chat.error.value).toBeUndefined()
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await paging
    await vi.waitFor(() => expect(root.api.chat.flat.value).toEqual([0, 1, 2, 3]))
    root.dispose()
  })
})

describe('infinite queries on the devtools bus and in plugin writes', () => {
  test('fetches emit start / success with queryId; fetch writes carry pageParams', async () => {
    const writes: WriteEvent[] = []
    const recorder = definePlugin({
      name: 'recorder',
      setup: () => ({ onWrite: (e) => writes.push(e) }),
    })
    const q = defineChat('parity/devtools', async (n) => page(n))
    const root = createRoot(
      defineController((ctx) => ({ chat: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps, plugins: [recorder] },
    )
    const events: Array<{ type: string; queryId?: string }> = []
    const unsub = root.debug.subscribe((e) => events.push(e as { type: string; queryId?: string }))
    await root.api.chat.refetch()
    await root.api.chat.fetchNextPage()
    unsub()
    const fetches = events.filter((e) => e.type.startsWith('cache:fetch'))
    expect(fetches.map((e) => e.type)).toEqual([
      'cache:fetch-start',
      'cache:fetch-success',
      'cache:fetch-start',
      'cache:fetch-success',
    ])
    expect(fetches.every((e) => e.queryId === 'parity/devtools')).toBe(true)
    const last = writes[writes.length - 1]
    expect(last?.source).toBe('fetch')
    expect(last?.pageParams).toEqual([0, 1])
    root.dispose()
  })
})
