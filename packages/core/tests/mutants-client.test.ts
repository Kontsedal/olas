/**
 * Behaviour of `query/client.ts` that the other suites exercise without
 * pinning: gc timing and subscriber counting for regular and infinite
 * entries, the root-wide `structuralShare` default, hydration of ids the root
 * has not seen and of payloads that cannot seed pages, the one-shot hydration
 * slot, the plugin query and mutation hosts (ref identity, write versus
 * replace, runner slots, disposal), module-level routing after disposal, the
 * devtools `cache:set-data` / `cache:invalidated` events, invalidation events
 * and error context, optimistic rollback reporting, prefetch after a failed
 * refetch, and the timers a disposed root leaves behind.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type ActivityEvent,
  bindQuery,
  createQuery,
  createRoot,
  type DebugEvent,
  defineController,
  defineInfiniteQuery,
  defineMutation,
  definePlugin,
  defineQuery,
  type ErrorContext,
  type InvalidateEvent,
  type PluginHost,
  type QueryHost,
  queryEngine,
  type RemoveEvent,
  type WriteEvent,
} from '../src'
import { __resetFocusOnlineForTests } from '../src/query/focus-online'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
  __resetFocusOnlineForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
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

type Page = { n: number; next: number | null }
/** Page `n` of a three-page feed. */
const page = (n: number): Page => ({ n, next: n < 2 ? n + 1 : null })

/** A plugin that hands its host out and records the observation hooks. */
function recorder(name = 'rec') {
  const log = {
    host: undefined as PluginHost | undefined,
    writes: [] as WriteEvent[],
    invalidations: [] as InvalidateEvent[],
    removals: [] as RemoveEvent[],
    activations: [] as ActivityEvent[],
    deactivations: [] as ActivityEvent[],
  }
  const plugin = definePlugin({
    name,
    setup(host) {
      log.host = host
      return {
        onWrite: (e) => log.writes.push(e),
        onInvalidate: (e) => log.invalidations.push(e),
        onRemove: (e) => log.removals.push(e),
        onActivate: (e) => log.activations.push(e),
        onDeactivate: (e) => log.deactivations.push(e),
      }
    },
  })
  return { plugin, log }
}

function queriesOf(log: { host: PluginHost | undefined }): QueryHost {
  const queries = log.host?.queries
  if (!queries) throw new Error('plugin host has no query access')
  return queries
}

/** Records the root's devtools events and projects the cache ones. */
function devtoolsOf(root: { debug: { subscribe(h: (e: DebugEvent) => void): () => void } }) {
  const events: DebugEvent[] = []
  root.debug.subscribe((e) => events.push(e))
  return {
    events,
    setData: (queryId: string) =>
      events.flatMap((e) =>
        e.type === 'cache:set-data' && e.queryId === queryId
          ? [{ queryKey: e.queryKey, source: e.source, data: e.data }]
          : [],
      ),
    invalidated: (queryId: string) =>
      events.flatMap((e) =>
        e.type === 'cache:invalidated' && e.queryId === queryId ? [e.queryKey] : [],
      ),
  }
}

const emptyRoot = (plugins: ReturnType<typeof definePlugin>[] = []) =>
  keep(
    createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: {}, plugins },
    ),
  )

describe('gc timing', () => {
  test('an entry nothing subscribes to lives for the default five minutes, then goes', async () => {
    vi.useFakeTimers()
    const q = defineQuery({
      id: 'mut-client/default-gc',
      key: (k: string) => [k],
      fetcher: async () => 'x',
    })
    const handle = emptyRoot().bindQuery(q)
    handle.write('k', () => 'written')
    await flush()
    expect(handle.peek('k')).toBe('written')
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(handle.peek('k')).toBe('written')
    await vi.advanceTimersByTimeAsync(1)
    expect(handle.peek('k')).toBeUndefined()
  })

  test('an orphan entry with a positive gcTime outlives the tick it was written in', async () => {
    vi.useFakeTimers()
    const q = defineQuery({
      id: 'mut-client/orphan-gc',
      key: (k: string) => [k],
      fetcher: async () => 'x',
      gcTime: 1_000,
    })
    const handle = emptyRoot().bindQuery(q)
    handle.write('k', () => 'written')
    await flush()
    expect(handle.peek('k')).toBe('written')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(handle.peek('k')).toBeUndefined()
  })
})

describe('subscriber counting', () => {
  test('a regular entry keeps polling while one of its two subscribers remains', async () => {
    vi.useFakeTimers()
    let calls = 0
    const q = defineQuery({
      id: 'mut-client/two-subs-poll',
      key: () => ['k'],
      fetcher: async () => ++calls,
      refetchInterval: 100,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const a = root.api.open()
    const b = root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    a.dispose()
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toBe(3)
    expect(b.api.s.data.value).toBe(3)
  })

  test('an infinite entry keeps polling while one of its two subscribers remains', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'mut-client/two-subs-poll-inf',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchInterval: 100,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const a = root.api.open()
    root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    a.dispose()
    await vi.advanceTimersByTimeAsync(200)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  test('an infinite entry activates on its first subscriber and deactivates on its last', async () => {
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-activity',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const a = root.api.open()
    const b = root.api.open()
    await flush()
    expect(log.activations.map((e) => e.key)).toEqual([['feed']])
    a.dispose()
    expect(log.deactivations).toEqual([])
    b.dispose()
    expect(log.deactivations.map((e) => e.key)).toEqual([['feed']])
    expect(log.activations).toHaveLength(1)
  })

  test('an infinite entry stops polling once its last subscriber leaves', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-release-poll',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchInterval: 100,
      gcTime: 60_000,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          open: () => ctx.attach(child, undefined),
          handle: bindQuery(ctx, inf),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const opened = root.api.open()
    await vi.advanceTimersByTimeAsync(100)
    expect(fetcher).toHaveBeenCalledTimes(2)
    opened.dispose()
    await vi.advanceTimersByTimeAsync(500)
    expect(fetcher).toHaveBeenCalledTimes(2)
    // Still cached (inside gcTime), just no longer polled.
    expect(root.api.handle.peek()).toEqual([page(0)])
  })
})

describe('focus refetch of infinite entries', () => {
  /** A stand-in `window` the shared focus listener attaches to. */
  const stubWindow = (): EventTarget => {
    const win = new EventTarget()
    vi.stubGlobal('window', win)
    return win
  }

  test('an infinite query that did not opt in ignores window focus', async () => {
    const win = stubWindow()
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-no-focus',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    win.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('an infinite entry stops refetching on focus once its last subscriber leaves', async () => {
    const win = stubWindow()
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-focus-release',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchOnWindowFocus: true,
      gcTime: 60_000,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const opened = root.api.open()
    await flush()
    win.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    opened.dispose()
    win.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('root-wide structuralShare default', () => {
  test('defaults.structuralShare false hands a refetch its own objects on a regular query', async () => {
    const q = defineQuery({
      id: 'mut-client/share-off',
      key: () => ['k'],
      fetcher: async () => ({ v: 1 }),
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine({ defaults: { structuralShare: false } }), deps: {} },
      ),
    )
    await root.waitForIdle()
    const first = root.api.s.data.value
    await root.api.s.refetch()
    expect(root.api.s.data.value).toEqual(first)
    expect(root.api.s.data.value).not.toBe(first)
  })

  test('defaults.structuralShare false hands a refetch its own head page on an infinite query', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-client/share-off-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        { queries: queryEngine({ defaults: { structuralShare: false } }), deps: {} },
      ),
    )
    await root.waitForIdle()
    const head = root.api.feed.pages.value[0]
    await root.api.feed.refetch()
    expect(root.api.feed.pages.value[0]).toEqual(head)
    expect(root.api.feed.pages.value[0]).not.toBe(head)
  })
})

describe('hydration', () => {
  test('root.hydrate buffers a row for an id this root has never seen; its first subscriber adopts it', async () => {
    const fetcher = vi.fn(async () => 'fetched')
    const q = defineQuery({
      id: 'mut-client/hydrate-unknown',
      key: () => ['k'],
      fetcher,
      staleTime: 60_000,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    root.hydrate({
      version: 1,
      entries: [
        { id: 'mut-client/hydrate-unknown', key: ['k'], data: 'server', lastUpdatedAt: Date.now() },
      ],
    })
    const opened = root.api.open()
    expect(opened.api.s.data.value).toBe('server')
    await flush()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('a live infinite entry ignores a payload without pageParams, and one with no pages', async () => {
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-bad-payload',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.waitForIdle()
    const writes = log.writes.length
    root.hydrate({
      version: 1,
      entries: [
        { id: 'mut-client/inf-bad-payload', key: ['feed'], data: [page(5)], lastUpdatedAt: 1 },
      ],
    })
    root.hydrate({
      version: 1,
      entries: [
        {
          id: 'mut-client/inf-bad-payload',
          key: ['feed'],
          data: [],
          pageParams: [],
          lastUpdatedAt: 1,
        },
      ],
    })
    expect(root.api.feed.pages.value).toEqual([page(0)])
    expect(log.writes).toHaveLength(writes)
  })

  test('a buffered regular payload seeds one entry only; the next entry for the key fetches', async () => {
    const fetcher = vi.fn(async () => 'fetched')
    const q = defineQuery({
      id: 'mut-client/hydrate-once',
      key: () => ['k'],
      fetcher,
      staleTime: 60_000,
      gcTime: 0,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        {
          queries: queryEngine(),
          deps: {},
          hydrate: {
            version: 1,
            entries: [
              {
                id: 'mut-client/hydrate-once',
                key: ['k'],
                data: 'server',
                lastUpdatedAt: Date.now(),
              },
            ],
          },
        },
      ),
    )
    const first = root.api.open()
    expect(first.api.s.data.value).toBe('server')
    first.dispose() // gcTime 0: the entry is collected at once
    const second = root.api.open()
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(second.api.s.data.value).toBe('fetched')
  })

  test('a buffered infinite payload seeds one entry only; the next entry for the key fetches', async () => {
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam + 10))
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-hydrate-once',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
      gcTime: 0,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        {
          queries: queryEngine(),
          deps: {},
          hydrate: {
            version: 1,
            entries: [
              {
                id: 'mut-client/inf-hydrate-once',
                key: ['feed'],
                data: [page(0)],
                pageParams: [0],
                lastUpdatedAt: Date.now(),
              },
            ],
          },
        },
      ),
    )
    const first = root.api.open()
    expect(first.api.feed.pages.value).toEqual([page(0)])
    first.dispose()
    const second = root.api.open()
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(second.api.feed.pages.value).toEqual([page(10)])
  })

  test('adopting a buffered infinite payload reports one hydrate write with its pages and params', async () => {
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-adopt-write',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      staleTime: 60_000,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    queriesOf(log).hydrate({
      version: 1,
      entries: [
        {
          id: 'mut-client/inf-adopt-write',
          key: ['feed'],
          data: [page(0), page(1)],
          pageParams: [0, 1],
          lastUpdatedAt: Date.now(),
        },
      ],
    })
    root.api.open()
    await flush()
    expect(log.writes).toHaveLength(1)
    expect(log.writes[0]).toMatchObject({
      key: ['feed'],
      source: 'hydrate',
      origin: 'rec',
      data: [page(0), page(1)],
      pageParams: [0, 1],
    })
  })

  test('a buffered infinite payload whose params do not align reports no write and fetches', async () => {
    const { plugin, log } = recorder()
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'mut-client/inf-adopt-unaligned',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    root.hydrate({
      version: 1,
      entries: [
        {
          id: 'mut-client/inf-adopt-unaligned',
          key: ['feed'],
          data: [page(0), page(1)],
          pageParams: [0],
          lastUpdatedAt: Date.now(),
        },
      ],
    })
    root.api.open()
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(log.writes.map((w) => w.source)).toEqual(['fetch'])
  })
})

describe('plugin query host', () => {
  test('every event and host.get hand out one ref object per query', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'mut-client/ref-identity',
      key: (k: string) => [k],
      fetcher: async () => 'x',
    })
    const handle = emptyRoot([plugin]).bindQuery(q)
    handle.write('a', () => 'one')
    handle.write('b', () => 'two')
    const [first, second] = log.writes
    expect(first?.query).toBe(second?.query)
    expect(queriesOf(log).get('mut-client/ref-identity')).toBe(first?.query)
  })

  test('a query bound through root.bindQuery is addressable before it holds an entry', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({ id: 'mut-client/host-bound', key: () => ['k'], fetcher: async () => 1 })
    const inf = defineInfiniteQuery({
      id: 'mut-client/host-bound-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = emptyRoot([plugin])
    root.bindQuery(q)
    root.bindQuery(inf)
    const host = queriesOf(log)
    expect(host.get('mut-client/host-bound')).toEqual({
      id: 'mut-client/host-bound',
      kind: 'query',
      meta: {},
    })
    // Known ids with no entries: every key-addressed operation is a no-op.
    expect(host.peek('mut-client/host-bound', ['k'])).toBeUndefined()
    expect(host.peek('mut-client/host-bound-inf', ['feed'])).toBeUndefined()
    expect(() => {
      host.write('mut-client/host-bound', ['k'], () => 2)
      host.replace('mut-client/host-bound-inf', ['feed'], [page(0)])
    }).not.toThrow()
    await expect(host.invalidate('mut-client/host-bound-inf', ['feed'])).resolves.toBeUndefined()
    expect(log.writes).toEqual([])
    expect(root.debug.queryEntries()).toEqual([])
  })

  test('peek on an infinite entry whose first fetch is in flight is an empty pages array', async () => {
    const { plugin, log } = recorder()
    const gate = deferred<Page>()
    const inf = defineInfiniteQuery({
      id: 'mut-client/host-peek-pending',
      key: () => ['feed'],
      fetcher: () => gate.promise,
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    expect(queriesOf(log).peek('mut-client/host-peek-pending', ['feed'])).toEqual([])
    gate.resolve(page(0))
    await flush()
    expect(queriesOf(log).peek('mut-client/host-peek-pending', ['feed'])).toEqual([page(0)])
  })

  describe('write patches, replace supersedes', () => {
    const setup = (suffix: string) => {
      const { plugin, log } = recorder()
      let gate: Deferred<string> | null = null
      const id = `mut-client/host-cancel-${suffix}`
      const q = defineQuery({
        id,
        key: () => ['k'],
        // Ignores its signal, so a superseded response still arrives later.
        fetcher: () => (gate ? gate.promise : Promise.resolve('v1')),
      })
      const root = keep(
        createRoot(
          defineController((ctx) => ({ s: createQuery(ctx, q) })),
          { queries: queryEngine(), deps: {}, plugins: [plugin] },
        ),
      )
      const hold = (): Deferred<string> => {
        gate = deferred<string>()
        return gate
      }
      return { root, host: queriesOf(log), id, hold }
    }

    test('host.write leaves a refetch in flight alone, and its response lands', async () => {
      const { root, host, id, hold } = setup('write')
      await root.waitForIdle()
      const gate = hold()
      const refetching = root.api.s.refetch()
      host.write(id, ['k'], () => 'patched')
      expect(root.api.s.data.value).toBe('patched')
      expect(root.api.s.isFetching.value).toBe(true)
      gate.resolve('v2')
      expect(await refetching).toBe('v2')
      expect(root.api.s.data.value).toBe('v2')
    })

    test('host.replace cancels a refetch in flight, and its response never lands', async () => {
      const { root, host, id, hold } = setup('replace')
      await root.waitForIdle()
      const gate = hold()
      const refetching = root.api.s.refetch()
      host.replace(id, ['k'], 'replaced')
      expect(root.api.s.isFetching.value).toBe(false)
      gate.resolve('v2')
      expect(await refetching).toBe('replaced')
      expect(root.api.s.data.value).toBe('replaced')
    })

    test('host.replace with undefined leaves the first fetch in flight to land', async () => {
      const { root, host, id, hold } = setup('replace-undefined')
      const gate = hold()
      const s = root.api.s
      // The subscription's first fetch is already out; `hold` gates the next one.
      await root.waitForIdle()
      expect(s.data.value).toBe('v1')
      const refetching = s.refetch()
      host.replace(id, ['k'], undefined)
      expect(s.isFetching.value).toBe(true)
      gate.resolve('v2')
      expect(await refetching).toBe('v2')
      expect(s.data.value).toBe('v2')
    })
  })

  test('host.write on an infinite entry leaves a refetch in flight alone', async () => {
    const { plugin, log } = recorder()
    let gate: Deferred<Page> | null = null
    const inf = defineInfiniteQuery({
      id: 'mut-client/host-write-inf',
      key: () => ['feed'],
      fetcher: ({ pageParam }) => (gate ? gate.promise : Promise.resolve(page(pageParam))),
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.waitForIdle()
    gate = deferred<Page>()
    const refetching = root.api.feed.refetch()
    queriesOf(log).write('mut-client/host-write-inf', ['feed'], () => [page(7)])
    expect(root.api.feed.isFetching.value).toBe(true)
    gate.resolve(page(8))
    await refetching
    expect(root.api.feed.pages.value).toEqual([page(8)])
  })

  test('a regular write event carries no pageParams field at all', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({ id: 'mut-client/no-params', key: () => ['k'], fetcher: async () => 1 })
    emptyRoot([plugin])
      .bindQuery(q)
      .write(() => 2)
    expect(log.writes).toHaveLength(1)
    expect('pageParams' in (log.writes[0] as object)).toBe(false)
  })

  test('onRemove names gc as the reason an entry left', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'mut-client/remove-reason',
      key: () => ['k'],
      fetcher: async () => 1,
      gcTime: 0,
    })
    emptyRoot([plugin])
      .bindQuery(q)
      .write(() => 2)
    await flush()
    expect(log.removals).toHaveLength(1)
    expect(log.removals[0]).toMatchObject({ key: ['k'], reason: 'gc' })
  })

  test('after the root is disposed the host knows no query', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'mut-client/host-after-dispose',
      key: () => ['k'],
      fetcher: async () => 1,
    })
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: {}, plugins: [plugin] },
    )
    root.bindQuery(q).write(() => 2)
    const host = queriesOf(log)
    expect(host.get('mut-client/host-after-dispose')).toBeDefined()
    root.dispose()
    expect(host.get('mut-client/host-after-dispose')).toBeUndefined()
    expect(host.keys('mut-client/host-after-dispose')).toEqual([])
  })
})

describe('plugin mutation host', () => {
  test('each registered id runs its own definition', async () => {
    const { plugin, log } = recorder()
    defineMutation({ id: 'mut-client/run-a', mutate: async (v: number) => `a${v}` })
    defineMutation({ id: 'mut-client/run-b', mutate: async (v: number) => `b${v}` })
    emptyRoot([plugin])
    const mutations = log.host?.mutations
    expect(await mutations?.run('mut-client/run-a', 1)).toBe('a1')
    expect(await mutations?.run('mut-client/run-b', 2)).toBe('b2')
    expect(await mutations?.run('mut-client/run-a', 3)).toBe('a3')
  })

  test("a plugin's runs appear on the devtools bus under the plugin's path", async () => {
    const { plugin, log } = recorder()
    defineMutation({ id: 'mut-client/run-path', mutate: async (v: number) => v })
    const root = emptyRoot([plugin])
    const { events } = devtoolsOf(root)
    await log.host?.mutations?.run('mut-client/run-path', 1)
    const run = events.find((e) => e.type === 'mutation:run')
    expect(run).toMatchObject({ path: ['plugin', 'rec'], name: 'mut-client/run-path', vars: 1 })
  })

  test('disposing the root aborts a run a plugin started', async () => {
    const { plugin, log } = recorder()
    let seen: AbortSignal | undefined
    defineMutation({
      id: 'mut-client/run-dispose',
      mutate: (_v: number, { signal }) => {
        seen = signal
        return new Promise<number>(() => {})
      },
    })
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: {}, plugins: [plugin] },
    )
    const running = log.host?.mutations?.run('mut-client/run-dispose', 1)
    running?.catch(() => {})
    await flush()
    expect(seen?.aborted).toBe(false)
    root.dispose()
    expect(seen?.aborted).toBe(true)
  })
})

describe('module-level routing', () => {
  test('root.bindQuery makes the root the target of the module-level operations', async () => {
    const q = defineQuery({
      id: 'mut-client/route-bound',
      key: (k: string) => [k],
      fetcher: async () => 'x',
    })
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    q.write('k', () => 'via module')
    expect(handle.peek('k')).toBe('via module')
  })

  test('a disposed root stops being a target, however it used the query', async () => {
    const q = defineQuery({
      id: 'mut-client/route-q',
      key: (k: string) => [k],
      fetcher: async () => 'x',
    })
    const bound = defineInfiniteQuery({
      id: 'mut-client/route-inf-bound',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const used = defineInfiniteQuery({
      id: 'mut-client/route-inf-used',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const first = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, used, () => ['k']) })),
      { queries: queryEngine(), deps: {} },
    )
    first.bindQuery(q)
    first.bindQuery(bound)
    await first.waitForIdle()
    first.dispose()

    const second = emptyRoot()
    second.bindQuery(q).write('k', () => 'second')
    second.bindQuery(bound).write('k', () => [page(1)])
    second.bindQuery(used).write('k', () => [page(2)])
    // One live root per query again, so nothing is ambiguous.
    expect(q.peek('k')).toBe('second')
    expect(bound.peek('k')).toEqual([page(1)])
    expect(used.peek('k')).toEqual([page(2)])
  })
})

describe('devtools cache events', () => {
  test('write, replace and a rollback each emit cache:set-data with their source', async () => {
    const q = defineQuery({
      id: 'mut-client/dt-regular',
      key: () => ['k'],
      fetcher: async () => 'v',
    })
    const root = emptyRoot()
    const dt = devtoolsOf(root)
    const handle = root.bindQuery(q)
    handle.write(() => 'written')
    handle.replace('replaced')
    handle.setData(() => 'guess').rollback()
    expect(dt.setData('mut-client/dt-regular')).toEqual([
      { queryKey: ['k'], source: 'write', data: 'written' },
      { queryKey: ['k'], source: 'replace', data: 'replaced' },
      { queryKey: ['k'], source: 'optimistic', data: 'guess' },
      { queryKey: ['k'], source: 'rollback', data: 'replaced' },
    ])
  })

  test('plugin host writes emit cache:set-data with their source', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({ id: 'mut-client/dt-host', key: () => ['k'], fetcher: async () => 'v' })
    const root = emptyRoot([plugin])
    const dt = devtoolsOf(root)
    root.bindQuery(q).write(() => 'seed')
    const host = queriesOf(log)
    host.write('mut-client/dt-host', ['k'], () => 'patched')
    host.replace('mut-client/dt-host', ['k'], 'whole')
    expect(dt.setData('mut-client/dt-host').map((e) => [e.source, e.data])).toEqual([
      ['write', 'seed'],
      ['write', 'patched'],
      ['replace', 'whole'],
    ])
  })

  test('hydrating a live entry and adopting a buffered row each emit a hydrate event', async () => {
    const live = defineQuery({
      id: 'mut-client/dt-hydrate-live',
      key: () => ['k'],
      fetcher: async () => 'v',
    })
    const later = defineQuery({
      id: 'mut-client/dt-hydrate-later',
      key: () => ['k'],
      fetcher: async () => 'v',
      staleTime: 60_000,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, later) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          s: createQuery(ctx, live),
          open: () => ctx.attach(child, undefined),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    const dt = devtoolsOf(root)
    root.hydrate({
      version: 1,
      entries: [
        { id: 'mut-client/dt-hydrate-live', key: ['k'], data: 'server', lastUpdatedAt: 1 },
        {
          id: 'mut-client/dt-hydrate-later',
          key: ['k'],
          data: 'buffered',
          lastUpdatedAt: Date.now(),
        },
      ],
    })
    expect(dt.setData('mut-client/dt-hydrate-live')).toEqual([
      { queryKey: ['k'], source: 'hydrate', data: 'server' },
    ])
    expect(dt.setData('mut-client/dt-hydrate-later')).toEqual([])
    root.api.open()
    expect(dt.setData('mut-client/dt-hydrate-later')).toEqual([
      { queryKey: ['k'], source: 'hydrate', data: 'buffered' },
    ])
  })

  test('infinite write, replace and optimistic writes emit cache:set-data with their pages', async () => {
    const inf = defineInfiniteQuery({
      id: 'mut-client/dt-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = emptyRoot()
    const dt = devtoolsOf(root)
    const handle = root.bindQuery(inf)
    handle.write(() => [page(0)])
    handle.replace([page(1)])
    handle.setData(() => [page(2)]).rollback()
    expect(dt.setData('mut-client/dt-inf')).toEqual([
      { queryKey: ['feed'], source: 'write', data: [page(0)] },
      { queryKey: ['feed'], source: 'replace', data: [page(1)] },
      { queryKey: ['feed'], source: 'optimistic', data: [page(2)] },
      { queryKey: ['feed'], source: 'rollback', data: [page(1)] },
    ])
  })

  test('invalidateAll, and infinite invalidate / invalidateAll, emit cache:invalidated per key', async () => {
    const q = defineQuery({
      id: 'mut-client/dt-inv',
      key: (k: string) => [k],
      fetcher: async () => 'v',
    })
    const inf = defineInfiniteQuery({
      id: 'mut-client/dt-inv-inf',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = emptyRoot()
    const dt = devtoolsOf(root)
    const a = root.bindQuery(q)
    const ia = root.bindQuery(inf)
    a.write('x', () => '1')
    a.write('y', () => '2')
    ia.write('x', () => [page(0)])
    ia.write('y', () => [page(0)])
    await a.invalidateAll()
    await ia.invalidate('x')
    await ia.invalidateAll()
    expect(dt.invalidated('mut-client/dt-inv')).toEqual([['x'], ['y']])
    expect(dt.invalidated('mut-client/dt-inv-inf')).toEqual([['x'], ['x'], ['y']])
  })

  test('the debug snapshot describes a regular entry field by field', async () => {
    const q = defineQuery({
      id: 'mut-client/dt-snapshot',
      key: () => ['k'],
      fetcher: async () => 'v',
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    expect(root.debug.queryEntries()).toEqual([
      {
        queryId: 'mut-client/dt-snapshot',
        key: ['k'],
        status: 'success',
        data: 'v',
        error: undefined,
        lastUpdatedAt: expect.any(Number),
        isStale: true,
        isFetching: false,
        hasPendingMutations: false,
      },
    ])
  })
})

describe('invalidation', () => {
  test('invalidateAll and the infinite invalidations report one onInvalidate per key with the origin', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'mut-client/inv-plugin',
      key: (k: string) => [k],
      fetcher: async () => 'v',
    })
    const inf = defineInfiniteQuery({
      id: 'mut-client/inv-plugin-inf',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = emptyRoot([plugin])
    const a = root.bindQuery(q, { origin: 'app' })
    const ia = root.bindQuery(inf, { origin: 'app' })
    a.write('x', () => '1')
    a.write('y', () => '2')
    ia.write('x', () => [page(0)])
    ia.write('y', () => [page(0)])
    await a.invalidateAll()
    await ia.invalidate('y')
    await ia.invalidateAll()
    expect(log.invalidations.map((e) => [e.query.id, e.key, e.origin])).toEqual([
      ['mut-client/inv-plugin', ['x'], 'app'],
      ['mut-client/inv-plugin', ['y'], 'app'],
      ['mut-client/inv-plugin-inf', ['y'], 'app'],
      ['mut-client/inv-plugin-inf', ['x'], 'app'],
      ['mut-client/inv-plugin-inf', ['y'], 'app'],
    ])
  })

  test('a refetch an invalidate started, then cancelled, reaches no onError', async () => {
    const onError = vi.fn()
    let gate: Deferred<string> | null = null
    const q = defineQuery({
      id: 'mut-client/inv-cancel',
      key: () => ['k'],
      fetcher: () => (gate ? gate.promise : Promise.resolve('v1')),
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {}, onError },
      ),
    )
    await root.waitForIdle()
    gate = deferred<string>()
    const handle = root.bindQuery(q)
    const invalidating = handle.invalidate()
    handle.cancel()
    gate.resolve('late')
    await invalidating
    expect(onError).not.toHaveBeenCalled()
    expect(root.api.s.data.value).toBe('v1')
  })

  test('a failing refetch an invalidate started reports a cache error naming the entry', async () => {
    const onError = vi.fn<(err: unknown, context: ErrorContext) => void>()
    let calls = 0
    const q = defineQuery({
      id: 'mut-client/inv-error',
      key: () => ['k'],
      fetcher: async () => {
        calls += 1
        if (calls > 1) throw new Error('refetch failed')
        return 'v1'
      },
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {}, onError },
      ),
    )
    await root.waitForIdle()
    await root.bindQuery(q).invalidate()
    expect(onError).toHaveBeenCalledTimes(1)
    const [err, context] = onError.mock.calls[0] as [unknown, ErrorContext]
    expect((err as Error).message).toBe('refetch failed')
    expect(context).toMatchObject({
      kind: 'cache',
      controllerPath: [],
      queryId: 'mut-client/inv-error',
      key: ['k'],
    })
  })
})

describe('cancel', () => {
  test('cancel for a key with no entry is a no-op while other keys are cached', async () => {
    const q = defineQuery({
      id: 'mut-client/cancel-absent',
      key: (k: string) => [k],
      fetcher: async () => 'v',
    })
    const inf = defineInfiniteQuery({
      id: 'mut-client/cancel-absent-inf',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = emptyRoot()
    const a = root.bindQuery(q)
    const ia = root.bindQuery(inf)
    a.write('present', () => 'p')
    ia.write('present', () => [page(0)])
    expect(() => {
      a.cancel('absent')
      ia.cancel('absent')
    }).not.toThrow()
    expect(a.peek('present')).toBe('p')
    expect(ia.peek('present')).toEqual([page(0)])
  })
})

describe('optimistic writes and their rollback', () => {
  test('rolling back a regular layer that is not on top reports no write', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({ id: 'mut-client/splice', key: () => ['k'], fetcher: async () => 'v' })
    const handle = emptyRoot([plugin]).bindQuery(q)
    handle.write(() => 'server')
    const lower = handle.setData(() => 'one')
    const upper = handle.setData(() => 'two')
    const before = log.writes.length
    lower.rollback()
    expect(handle.peek()).toBe('two')
    expect(log.writes).toHaveLength(before)
    upper.rollback()
    expect(handle.peek()).toBe('server')
    expect(log.writes.slice(before).map((w) => [w.source, w.data])).toEqual([
      ['rollback', 'server'],
    ])
  })

  test('infinite setData reports an optimistic write; only a rollback that changes pages reports', async () => {
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'mut-client/splice-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const handle = emptyRoot([plugin]).bindQuery(inf)
    handle.write(() => [page(0)])
    const lower = handle.setData(() => [page(1)])
    const upper = handle.setData(() => [page(2)])
    expect(log.writes.map((w) => w.source)).toEqual(['write', 'optimistic', 'optimistic'])
    lower.rollback()
    expect(handle.peek()).toEqual([page(2)])
    expect(log.writes).toHaveLength(3)
    upper.rollback()
    expect(handle.peek()).toEqual([page(0)])
    expect(log.writes.slice(3).map((w) => [w.source, w.data])).toEqual([['rollback', [page(0)]]])
  })
})

describe('canonical infinite writes', () => {
  test('write and replace report their source and push no optimistic layer', async () => {
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'mut-client/canonical-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = emptyRoot([plugin])
    const handle = root.bindQuery(inf, { origin: 'feed-sync' })
    handle.write(() => [page(0)])
    handle.replace([page(1)])
    expect(log.writes.map((w) => [w.source, w.origin, w.data])).toEqual([
      ['write', 'feed-sync', [page(0)]],
      ['replace', 'feed-sync', [page(1)]],
    ])
    expect(root.debug.queryEntries()[0]?.hasPendingMutations).toBe(false)
  })
})

describe('prefetch', () => {
  test('a gcTime 0 prefetch holds its entry for the fetch, resolves, then lets it go', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'mut-client/prefetch-gc0',
      key: () => ['k'],
      fetcher: async () => 'fetched',
      gcTime: 0,
    })
    const handle = emptyRoot([plugin]).bindQuery(q)
    expect(await handle.prefetch()).toBe('fetched')
    expect(log.writes.map((w) => w.source)).toEqual(['fetch'])
    expect(log.activations).toHaveLength(1)
    expect(log.deactivations).toHaveLength(1)
    expect(handle.peek()).toBeUndefined()
  })

  test('prefetch refetches an entry whose last refetch failed, fresh data or not', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'mut-client/prefetch-after-error',
      key: () => ['k'],
      fetcher: async () => {
        calls += 1
        if (calls === 2) throw new Error('down')
        return `v${calls}`
      },
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    await root.api.s.refetch().catch(() => {})
    expect(root.api.s.status.value).toBe('error')
    expect(await root.bindQuery(q).prefetch()).toBe('v3')
    expect(calls).toBe(3)
  })

  test('infinite prefetch refetches an entry whose last refetch failed, fresh pages or not', async () => {
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'mut-client/prefetch-after-error-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => {
        calls += 1
        if (calls === 2) throw new Error('down')
        return page(pageParam + calls)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    await root.api.feed.refetch().catch(() => {})
    expect(root.api.feed.status.value).toBe('error')
    expect(await root.bindQuery(inf).prefetch()).toEqual(page(3))
    expect(calls).toBe(3)
  })
})

describe('dehydrate and dispose', () => {
  test("an infinite entry dehydrates with the time its pages were fetched, not the dehydrate's", async () => {
    vi.useFakeTimers()
    const inf = defineInfiniteQuery({
      id: 'mut-client/dehydrate-time-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    const fetchedAt = Date.now()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(root.dehydrate().entries[0]?.lastUpdatedAt).toBe(fetchedAt)
  })

  test('a disposed root holds no cache: dehydrate and the debug snapshot come back empty', async () => {
    const q = defineQuery({
      id: 'mut-client/dispose-empty',
      key: () => ['k'],
      fetcher: async () => 'v',
    })
    const inf = defineInfiniteQuery({
      id: 'mut-client/dispose-empty-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q), feed: createQuery(ctx, inf) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    expect(root.dehydrate().entries).toHaveLength(2)
    root.dispose()
    expect(root.dehydrate().entries).toEqual([])
    expect(root.debug.queryEntries()).toEqual([])
  })

  test('disposing the root cancels the gc timers of entries nothing subscribes to', async () => {
    vi.useFakeTimers()
    const q = defineQuery({
      id: 'mut-client/dispose-gc',
      key: () => ['k'],
      fetcher: async () => 'v',
    })
    const inf = defineInfiniteQuery({
      id: 'mut-client/dispose-gc-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: {} },
    )
    root.bindQuery(q).write(() => 'orphan')
    root.bindQuery(inf).write(() => [page(0)])
    expect(vi.getTimerCount()).toBe(2)
    root.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('disposing the root stops polling on entries a still-pending prefetch holds', async () => {
    vi.useFakeTimers()
    // Ignores its signal and never settles, so the prefetches never let go.
    const never = new Promise<never>(() => {})
    const q = defineQuery({
      id: 'mut-client/dispose-poll',
      key: () => ['k'],
      fetcher: () => never,
      refetchInterval: 100,
    })
    const inf = defineInfiniteQuery({
      id: 'mut-client/dispose-poll-inf',
      key: () => ['feed'],
      fetcher: (): Promise<Page> => never,
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      refetchInterval: 100,
    })
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: {} },
    )
    void root.bindQuery(q).prefetch()
    void root.bindQuery(inf).prefetch()
    expect(vi.getTimerCount()).toBe(2) // one polling chain each
    root.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('waitForIdle safety bound', () => {
  test('gives up after exactly 100 rounds of a fetch that keeps restarting', async () => {
    let looping = true
    let fetches = 0
    const churn = definePlugin({
      name: 'churn',
      setup(host) {
        return {
          onWrite(e) {
            if (looping && e.source === 'fetch') void host.queries?.invalidate(e.query.id, e.key)
          },
        }
      },
    })
    const q = defineQuery({
      id: 'mut-client/churn',
      key: () => ['k'],
      // Settles a macrotask later, so each round waits out exactly one fetch.
      fetcher: () => {
        fetches += 1
        return new Promise<number>((resolve) => setTimeout(() => resolve(fetches), 0))
      },
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {}, plugins: [churn] },
      ),
    )
    const err = await root.waitForIdle().catch((e: unknown) => e)
    looping = false
    expect((err as Error).message).toContain('exceeded 100-iteration safety bound')
    // The subscription's first fetch, then one restart per round.
    expect(fetches).toBe(101)
  })
})
