/**
 * `query/client.ts` paths the main suites leave dark: the plugin query and
 * mutation hosts, hydration buffering, the debug snapshot of infinite entries,
 * the `waitForIdle` safety bound, infinite gc and cancel, stale gc drops, the
 * no-entry paths of bound handles, infinite prefetch and polling. Also the
 * zero-client fallbacks in `actions.ts` and the `null` / boolean key tags.
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
  defineMutation,
  definePlugin,
  defineQuery,
  type InvalidateEvent,
  type PluginHost,
  type QueryHost,
  queryEngine,
  type WriteEvent,
} from '../src'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
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
    removals: [] as string[],
  }
  const plugin = definePlugin({
    name,
    setup(host) {
      log.host = host
      return {
        onWrite: (e) => log.writes.push(e),
        onInvalidate: (e) => log.invalidations.push(e),
        onRemove: (e) => log.removals.push(`${e.query.id}:${JSON.stringify(e.key)}`),
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

describe('plugin query host', () => {
  test('get, keys and peek address regular and infinite entries by id', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'cov-client/host-q',
      key: (id: string) => [id],
      fetcher: async (_c, id: string) => `v-${id}`,
    })
    const unused = defineQuery({
      id: 'cov-client/host-unused',
      key: () => ['x'],
      fetcher: async () => 0,
    })
    const inf = defineInfiniteQuery({
      id: 'cov-client/host-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          a: createQuery(ctx, q, () => ['a']),
          feed: createQuery(ctx, inf),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.waitForIdle()
    root.bindQuery(unused) // known to the root, but it holds no entry
    const host = queriesOf(log)

    expect(host.get('nope')).toBeUndefined()
    expect(host.get('cov-client/host-q')).toEqual({
      id: 'cov-client/host-q',
      kind: 'query',
      meta: {},
    })
    expect(host.get('cov-client/host-inf')?.kind).toBe('infinite')

    expect(host.keys('nope')).toEqual([])
    expect(host.keys('cov-client/host-unused')).toEqual([])
    expect(host.keys('cov-client/host-q')).toEqual([['a']])
    expect(host.keys('cov-client/host-inf')).toEqual([['feed']])

    expect(host.peek('cov-client/host-q', ['a'])).toBe('v-a')
    expect(host.peek('cov-client/host-inf', ['feed'])).toEqual([page(0)])
    expect(host.peek('cov-client/host-inf', ['other'])).toBeUndefined()
    expect(host.peek('nope', ['a'])).toBeUndefined()
  })

  test('invalidate resolves without an event for an id this root has not used', async () => {
    const { plugin, log } = recorder()
    keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await expect(queriesOf(log).invalidate('nope', ['x'])).resolves.toBeUndefined()
    expect(log.invalidations).toEqual([])
  })

  test('replace on an infinite entry supersedes the refetch in flight', async () => {
    const { plugin, log } = recorder()
    let slow: Deferred<Page> | null = null
    const inf = defineInfiniteQuery({
      id: 'cov-client/host-replace',
      key: () => ['feed'],
      // Ignores its signal, so a superseded response still arrives later.
      fetcher: ({ pageParam }) => (slow ? slow.promise : Promise.resolve(page(pageParam))),
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
    slow = deferred<Page>()
    const refetching = root.api.feed.refetch()
    expect(root.api.feed.isFetching.value).toBe(true)

    queriesOf(log).replace('cov-client/host-replace', ['feed'], [page(7)])
    expect(root.api.feed.isFetching.value).toBe(false)
    expect(root.api.feed.pages.value).toEqual([page(7)])

    slow.resolve(page(0))
    // The superseded refetch resolves with what the entry settled on.
    expect(await refetching).toEqual([page(7)])
    expect(root.api.feed.pages.value).toEqual([page(7)])
    const replaced = log.writes.filter((w) => w.source === 'replace')
    expect(replaced).toHaveLength(1)
    expect(replaced[0]).toMatchObject({ origin: 'rec', data: [page(7)], pageParams: [0] })
  })

  test('write with aligned pageParams replaces them; a shorter write trims them', async () => {
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'cov-client/host-write-params',
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
    await root.api.feed.fetchNextPage()
    expect(root.api.feed.pages.value).toEqual([page(0), page(1)])
    const host = queriesOf(log)

    host.write('cov-client/host-write-params', ['feed'], () => [page(5), page(6)], {
      pageParams: [50, 60],
    })
    expect(log.writes.at(-1)).toMatchObject({ source: 'write', pageParams: [50, 60] })

    host.write('cov-client/host-write-params', ['feed'], (prev) => (prev as Page[]).slice(0, 1))
    expect(log.writes.at(-1)).toMatchObject({ data: [page(5)], pageParams: [50] })
    expect(root.dehydrate().entries[0]?.pageParams).toEqual([50])
  })

  test('hydrate applies a version-1 payload and drops any other version with a warning', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'cov-client/host-hydrate',
      key: () => ['k'],
      fetcher: async () => 'fetched',
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.waitForIdle()
    const host = queriesOf(log)
    host.hydrate({
      version: 1,
      entries: [{ id: 'cov-client/host-hydrate', key: ['k'], data: 'from-host', lastUpdatedAt: 1 }],
    })
    expect(root.api.s.data.value).toBe('from-host')
    expect(log.writes.at(-1)).toMatchObject({ source: 'hydrate', origin: 'rec', data: 'from-host' })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writes = log.writes.length
    host.hydrate({
      version: 2,
      entries: [{ id: 'cov-client/host-hydrate', key: ['k'], data: 'v2', lastUpdatedAt: 2 }],
    } as unknown as DehydratedState)
    expect(root.api.s.data.value).toBe('from-host')
    expect(log.writes).toHaveLength(writes)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unsupported state.version'),
      2,
      expect.any(String),
    )
  })

  test('dehydrate mirrors the root, and hashKey tags every value by type', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'cov-client/host-dehydrate',
      key: () => ['k'],
      fetcher: async () => 1,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.waitForIdle()
    const host = queriesOf(log)
    expect(host.dehydrate()).toEqual(root.dehydrate())
    expect(host.dehydrate().entries).toHaveLength(1)

    expect(host.hashKey([{ a: 1, b: 2 }])).toBe(host.hashKey([{ b: 2, a: 1 }]))
    expect(host.hashKey([null])).not.toBe(host.hashKey(['null']))
    expect(host.hashKey([null])).not.toBe(host.hashKey([undefined]))
    expect(host.hashKey([true])).not.toBe(host.hashKey(['true']))
    expect(host.hashKey([true])).not.toBe(host.hashKey([false]))
  })
})

describe('plugin mutation host', () => {
  test('run after the root is disposed rejects without calling mutate', async () => {
    const { plugin, log } = recorder()
    const mutate = vi.fn(async (v: number) => v * 2)
    defineMutation({ id: 'cov-client/after-dispose', mutate })
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [plugin],
      },
    )
    const mutations = log.host?.mutations
    expect(mutations).toBeTruthy()
    root.dispose()
    await expect(mutations?.run('cov-client/after-dispose', 1)).rejects.toThrow(
      'after the root was disposed',
    )
    expect(mutate).not.toHaveBeenCalled()
  })

  test('repeated runs of one id share a runner, so serial concurrency holds across them', async () => {
    const { plugin, log } = recorder()
    const gates: Array<Deferred<number>> = []
    defineMutation({
      id: 'cov-client/serial',
      concurrency: 'serial',
      mutate: (v: number) => {
        const gate = deferred<number>()
        gates.push(gate)
        return gate.promise.then((x) => x + v)
      },
    })
    keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const mutations = log.host?.mutations
    const first = mutations?.run('cov-client/serial', 1)
    const second = mutations?.run('cov-client/serial', 2)
    await flush()
    expect(gates).toHaveLength(1) // the second run waits its turn
    gates[0]?.resolve(10)
    expect(await first).toBe(11)
    await flush()
    expect(gates).toHaveLength(2)
    gates[1]?.resolve(20)
    expect(await second).toBe(22)
  })
})

describe('hydration buffering', () => {
  test('a createRoot payload with an unsupported version is dropped with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = vi.fn(async () => 'fresh')
    const q = defineQuery({
      id: 'cov-client/bad-version',
      key: () => ['k'],
      fetcher,
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
          hydrate: {
            version: 2,
            entries: [
              { id: 'cov-client/bad-version', key: ['k'], data: 'stale', lastUpdatedAt: 1 },
            ],
          } as unknown as DehydratedState,
        },
      ),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unsupported state.version'),
      2,
      expect.any(String),
    )
    await root.waitForIdle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(root.api.s.data.value).toBe('fresh')
  })

  test('root.hydrate buffers a row for a query bound without an entry; the first subscriber adopts it', async () => {
    const { plugin, log } = recorder()
    const fetcher = vi.fn(async (_c: unknown, id: string) => `fetched-${id}`)
    const q = defineQuery({
      id: 'cov-client/buffer',
      key: (id: string) => [id],
      fetcher,
      staleTime: 60_000,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q, () => ['a']) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    root.bindQuery(q) // the root knows the query, but holds no entry for it
    root.hydrate({
      version: 1,
      entries: [{ id: 'cov-client/buffer', key: ['a'], data: 'server', lastUpdatedAt: Date.now() }],
    })
    expect(root.debug.queryEntries()).toEqual([])

    const opened = root.api.open()
    expect(opened.api.s.status.value).toBe('success')
    expect(opened.api.s.data.value).toBe('server')
    await flush()
    expect(fetcher).not.toHaveBeenCalled()
    expect(log.writes.map((w) => w.source)).toEqual(['hydrate'])
  })

  test('infinite: root.hydrate buffers for a bound query; an unaligned payload for a live entry is ignored', async () => {
    const { plugin, log } = recorder()
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'cov-client/inf-buffer',
      key: () => ['feed'],
      fetcher,
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
    root.bindQuery(inf)
    root.hydrate({
      version: 1,
      entries: [
        {
          id: 'cov-client/inf-buffer',
          key: ['feed'],
          data: [page(0)],
          pageParams: [0],
          lastUpdatedAt: Date.now(),
        },
      ],
    })
    const opened = root.api.open()
    expect(opened.api.feed.pages.value).toEqual([page(0)])
    await flush()
    expect(fetcher).not.toHaveBeenCalled()

    const writes = log.writes.length
    // Two pages but one param: cannot seed pages, so the live entry keeps its own.
    root.hydrate({
      version: 1,
      entries: [
        {
          id: 'cov-client/inf-buffer',
          key: ['feed'],
          data: [page(5), page(6)],
          pageParams: [5],
          lastUpdatedAt: Date.now(),
        },
      ],
    })
    expect(opened.api.feed.pages.value).toEqual([page(0)])
    expect(log.writes).toHaveLength(writes)
  })
})

describe('debug snapshot and dehydrate', () => {
  test('queryEntries lists infinite entries with their pages as data', async () => {
    const inf = defineInfiniteQuery({
      id: 'cov-client/debug-inf',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
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
    expect(root.debug.queryEntries()).toEqual([
      expect.objectContaining({
        key: ['feed'],
        status: 'success',
        data: [page(0)],
        error: undefined,
        isFetching: false,
        hasPendingMutations: false,
      }),
    ])
  })

  test('dehydrate skips an infinite entry that has not succeeded', async () => {
    const inf = defineInfiniteQuery({
      id: 'cov-client/dehydrate-inf-error',
      key: () => ['feed'],
      fetcher: async (): Promise<Page> => {
        throw new Error('down')
      },
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const q = defineQuery({
      id: 'cov-client/dehydrate-ok',
      key: () => ['k'],
      fetcher: async () => 1,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ feed: createQuery(ctx, inf), ok: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    expect(root.api.feed.status.value).toBe('error')
    expect(root.dehydrate().entries.map((e) => e.id)).toEqual(['cov-client/dehydrate-ok'])
  })
})

describe('waitForIdle safety bound', () => {
  test('throws after 100 rounds, naming only the entries still fetching', async () => {
    let looping = true
    let restarts = 0
    // Every fetch result of a `loop` query re-invalidates its own entry, so
    // those entries never idle. The `calm` ones settle once.
    const churn = definePlugin({
      name: 'churn',
      setup(host) {
        return {
          onWrite(e) {
            if (!looping || e.source !== 'fetch' || !e.query.id.includes('/loop')) return
            if (++restarts > 5_000) return // a backstop, far past the 100 rounds
            void host.queries?.invalidate(e.query.id, e.key)
          },
        }
      },
    })
    const loop = defineQuery({ id: 'cov-client/loop', key: () => ['loop'], fetcher: async () => 1 })
    const calm = defineQuery({ id: 'cov-client/calm', key: () => ['calm'], fetcher: async () => 1 })
    const infLoop = defineInfiniteQuery({
      id: 'cov-client/loop-inf',
      key: () => ['loop-inf'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const infCalm = defineInfiniteQuery({
      id: 'cov-client/calm-inf',
      key: () => ['calm-inf'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          loop: createQuery(ctx, loop),
          calm: createQuery(ctx, calm),
          infLoop: createQuery(ctx, infLoop),
          infCalm: createQuery(ctx, infCalm),
        })),
        { queries: queryEngine(), deps: {}, plugins: [churn] },
      ),
    )
    const err = (await root.waitForIdle().catch((e: unknown) => e)) as Error & {
      unsettled: Array<{ key: readonly unknown[]; kind: string }>
      mutationsInflight: number
    }
    looping = false
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('exceeded 100-iteration safety bound')
    expect(err.unsettled).toEqual([
      { key: ['loop'], kind: 'data' },
      { key: ['loop-inf'], kind: 'infinite' },
    ])
    expect(err.mutationsInflight).toBe(0)
    expect(root.api.calm.status.value).toBe('success')
    expect(root.api.infCalm.status.value).toBe('success')
  })
})

describe('bindEntry', () => {
  test('a second subscriber with the same key but different call args warns; the first args win', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: number[] = []
    const q = defineQuery({
      id: 'cov-client/diverging-args',
      key: (id: string, _opts: { v: number }) => [id],
      fetcher: async (_c, id: string, opts: { v: number }) => {
        seen.push(opts.v)
        return id
      },
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          first: createQuery(ctx, q, () => ['a', { v: 1 }]),
          second: createQuery(ctx, q, () => ['a', { v: 2 }]),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('diverging callArgs'))
    expect(seen).toEqual([1])
    await root.api.second.refetch()
    expect(seen).toEqual([1, 1])
  })
})

describe('infinite gc', () => {
  test('a released infinite entry is collected after gcTime', async () => {
    vi.useFakeTimers()
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'cov-client/inf-gc',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      gcTime: 1_000,
    })
    const child = defineController((ctx) => ({ feed: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          open: () => ctx.attach(child, undefined),
          handle: bindQuery(ctx, inf),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => events.push(e))
    const opened = root.api.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.handle.peek()).toEqual([page(0)])
    opened.dispose()
    await vi.advanceTimersByTimeAsync(999)
    expect(root.api.handle.peek()).toEqual([page(0)])
    expect(log.removals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(root.api.handle.peek()).toBeUndefined()
    expect(log.removals).toEqual(['cov-client/inf-gc:["feed"]'])
    expect(events.filter((e) => e.type === 'cache:gc')).toHaveLength(1)
    expect(root.debug.queryEntries()).toEqual([])
  })

  test('an infinite entry written with no subscriber is collected after gcTime', async () => {
    vi.useFakeTimers()
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'cov-client/inf-orphan-gc',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      gcTime: 500,
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [plugin],
        },
      ),
    )
    const handle = root.bindQuery(inf)
    handle.write('a', () => [page(1)])
    await vi.advanceTimersByTimeAsync(250)
    handle.write('b', () => [page(2)])
    expect(handle.peek('a')).toEqual([page(1)])
    await vi.advanceTimersByTimeAsync(250)
    // `a` goes; `b`, written later, is still inside its own gcTime.
    expect(handle.peek('a')).toBeUndefined()
    expect(handle.peek('b')).toEqual([page(2)])
    expect(log.removals).toEqual(['cov-client/inf-orphan-gc:["a"]'])
    await vi.advanceTimersByTimeAsync(250)
    expect(handle.peek('b')).toBeUndefined()
    expect(log.removals).toEqual([
      'cov-client/inf-orphan-gc:["a"]',
      'cov-client/inf-orphan-gc:["b"]',
    ])
  })

  test('gcTime 0: an orphan write is dropped once the current microtask ends', async () => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: 'cov-client/gc0',
      key: (k: string) => [k],
      fetcher: async () => 'x',
      gcTime: 0,
    })
    const inf = defineInfiniteQuery({
      id: 'cov-client/gc0-inf',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      gcTime: 0,
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [plugin],
        },
      ),
    )
    const a = root.bindQuery(q)
    const ia = root.bindQuery(inf)
    a.write('k', () => 'patched')
    ia.write('k', () => [page(0)])
    // Still readable in the same tick as the write…
    expect(a.peek('k')).toBe('patched')
    expect(ia.peek('k')).toEqual([page(0)])
    await Promise.resolve()
    // …and gone after it.
    expect(a.peek('k')).toBeUndefined()
    expect(ia.peek('k')).toBeUndefined()
    expect([...log.removals].sort()).toEqual(['cov-client/gc0-inf:["k"]', 'cov-client/gc0:["k"]'])
  })

  test('gcTime 0: a prefetched infinite entry survives the orphan check and drops on release', async () => {
    const { plugin, log } = recorder()
    const inf = defineInfiniteQuery({
      id: 'cov-client/gc0-prefetch',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      gcTime: 0,
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [plugin],
        },
      ),
    )
    const ia = root.bindQuery(inf)
    expect(await ia.prefetch('p')).toEqual(page(0))
    // The prefetch held the entry while its fetch ran, so the fetch landed;
    // its release then collected the entry at once.
    expect(log.writes.filter((w) => w.source === 'fetch')).toHaveLength(1)
    expect(ia.peek('p')).toBeUndefined()
    expect(log.removals).toEqual(['cov-client/gc0-prefetch:["p"]'])
  })
})

describe('stale gc drops', () => {
  const setup = (suffix: string) => {
    const { plugin, log } = recorder()
    const q = defineQuery({
      id: `cov-client/stale-${suffix}`,
      key: () => ['k'],
      fetcher: async () => 'server',
      gcTime: 0,
    })
    const inf = defineInfiniteQuery({
      id: `cov-client/stale-inf-${suffix}`,
      key: () => ['k'],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      gcTime: 0,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q), f: createQuery(ctx, inf) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          open: () => ctx.attach(child, undefined),
          a: bindQuery(ctx, q),
          ia: bindQuery(ctx, inf),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    return { root, log }
  }

  test('an orphan check that runs after its entry was already collected is a no-op', async () => {
    const { root, log } = setup('gone')
    root.api.a.write(() => 'local') // creates the entries; their orphan checks are queued
    root.api.ia.write(() => [page(9)])
    const opened = root.api.open() // acquires both
    opened.dispose() // released with gcTime 0: collected right away
    expect(log.removals).toHaveLength(2)
    await flush() // the queued orphan checks now find nothing to drop
    expect(log.removals).toHaveLength(2)
    expect(root.debug.queryEntries()).toEqual([])
  })

  test('a stale orphan check leaves a newer entry under the same key alone', async () => {
    const { root, log } = setup('newer')
    root.api.a.write(() => 'local')
    root.api.ia.write(() => [page(9)])
    root.api.open().dispose() // the first pair is collected
    const second = root.api.open() // a new pair under the same keys
    await flush()
    expect(log.removals).toHaveLength(2) // only the first pair
    expect(root.debug.queryEntries()).toHaveLength(2)
    expect(second.api.s.data.value).toBe('server')
    expect(second.api.f.pages.value).toEqual([page(0)])
  })
})

describe('bound handles with nothing cached', () => {
  test('regular: invalidate, invalidateAll, cancel and cancelAll are no-ops without an entry', async () => {
    const { plugin, log } = recorder()
    const fetcher = vi.fn(async () => 'x')
    const q = defineQuery({ id: 'cov-client/noop', key: (k: string) => [k], fetcher })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [plugin],
        },
      ),
    )
    const a = root.bindQuery(q)
    await expect(a.invalidate('x')).resolves.toBeUndefined()
    await expect(a.invalidateAll()).resolves.toBeUndefined()
    a.cancel('x')
    a.cancelAll()
    expect(root.debug.queryEntries()).toEqual([])

    a.write('present', () => 'p')
    await expect(a.invalidate('absent')).resolves.toBeUndefined()
    expect(log.invalidations).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('infinite: the same operations and peek are no-ops without an entry', async () => {
    const { plugin, log } = recorder()
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'cov-client/noop-inf',
      key: (k: string) => [k],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [plugin],
        },
      ),
    )
    const ia = root.bindQuery(inf)
    expect(ia.peek('x')).toBeUndefined()
    await expect(ia.invalidate('x')).resolves.toBeUndefined()
    await expect(ia.invalidateAll()).resolves.toBeUndefined()
    ia.cancel('x')
    ia.cancelAll()
    expect(root.debug.queryEntries()).toEqual([])

    ia.write('present', () => [page(0)])
    await expect(ia.invalidate('absent')).resolves.toBeUndefined()
    expect(log.invalidations).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('infinite cancel through a bound handle', () => {
  test('cancel stops one key; cancelAll stops the rest; late pages never land', async () => {
    const pending: Array<Deferred<Page>> = []
    const inf = defineInfiniteQuery({
      id: 'cov-client/inf-cancel',
      key: (k: string) => [k],
      fetcher: () => {
        const d = deferred<Page>()
        pending.push(d)
        return d.promise
      },
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          a: createQuery(ctx, inf, () => ['a']),
          b: createQuery(ctx, inf, () => ['b']),
          handle: bindQuery(ctx, inf),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const { a, b, handle } = root.api
    expect(a.isFetching.value).toBe(true)
    expect(b.isFetching.value).toBe(true)

    handle.cancel('a')
    expect(a.isFetching.value).toBe(false)
    expect(a.status.value).toBe('idle') // nothing loaded yet
    expect(b.isFetching.value).toBe(true)

    handle.cancelAll()
    expect(b.isFetching.value).toBe(false)

    for (const d of pending) d.resolve(page(0))
    await flush()
    expect(a.pages.value).toEqual([])
    expect(b.pages.value).toEqual([])
  })
})

describe('prefetch', () => {
  test('prefetchInfinite fetches the first page, then serves it while fresh', async () => {
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'cov-client/prefetch-inf',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const ia = root.bindQuery(inf)
    expect(await ia.prefetch()).toEqual(page(0))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(ia.peek()).toEqual([page(0)])
    expect(await ia.prefetch()).toEqual(page(0))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('prefetch rejects with the fetcher error', async () => {
    const q = defineQuery({
      id: 'cov-client/prefetch-fail',
      key: () => ['k'],
      fetcher: async (): Promise<number> => {
        throw new Error('boom')
      },
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await expect(root.bindQuery(q).prefetch()).rejects.toThrow('boom')
  })
})

describe('unbound operations before any root', () => {
  test('setData with no client returns an inert snapshot and caches nothing', () => {
    const q = defineQuery({
      id: 'cov-client/unbound',
      key: (k: string) => [k],
      fetcher: async () => 1,
    })
    const inf = defineInfiniteQuery({
      id: 'cov-client/unbound-inf',
      key: (k: string) => [k],
      fetcher: async ({ pageParam }) => page(pageParam),
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
    })
    const snap = q.setData('k', () => 5)
    const infSnap = inf.setData('k', () => [page(0)])
    expect(() => {
      snap.rollback()
      snap.finalize()
      infSnap.rollback()
      infSnap.finalize()
    }).not.toThrow()
    expect(q.peek('k')).toBeUndefined()
    expect(inf.peek('k')).toBeUndefined()
    // A root created afterwards starts empty: the write went nowhere.
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: {} },
      ),
    )
    expect(root.bindQuery(q).peek('k')).toBeUndefined()
    expect(root.bindQuery(inf).peek('k')).toBeUndefined()
  })
})

describe('cache keys', () => {
  test('null and booleans are tagged apart from their string spellings', async () => {
    const seen: unknown[] = []
    const q = defineQuery({
      id: 'cov-client/key-tags',
      key: (k: unknown) => [k],
      fetcher: async (_c, k: unknown) => {
        seen.push(k)
        return String(k)
      },
    })
    const keyOf = (k: unknown) => (): [unknown] => [k]
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          n: createQuery(ctx, q, keyOf(null)),
          ns: createQuery(ctx, q, keyOf('null')),
          t: createQuery(ctx, q, keyOf(true)),
          ts: createQuery(ctx, q, keyOf('true')),
          again: createQuery(ctx, q, keyOf(null)),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    expect(seen).toEqual([null, 'null', true, 'true'])
    expect(root.debug.queryEntries()).toHaveLength(4)
  })
})

describe('infinite refetchInterval', () => {
  test('an interval that resolves to 0 stops polling with a warning', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = vi.fn(async ({ pageParam }: { pageParam: number }) => page(pageParam))
    const inf = defineInfiniteQuery({
      id: 'cov-client/inf-interval-zero',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: (p: Page) => p.next,
      refetchInterval: () => 0,
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
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refetchInterval resolved to 0'))
  })

  test('a tick while a fetch is in flight joins it instead of restarting it', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(
      ({ pageParam }: { pageParam: number }) =>
        new Promise<Page>((res) => setTimeout(() => res(page(pageParam)), 250)),
    )
    const inf = defineInfiniteQuery({
      id: 'cov-client/inf-interval-join',
      key: () => ['feed'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchInterval: 100,
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
    // Fetch 1 runs 0→250 (ticks at 100 and 200 skip); fetch 2 starts at the
    // 300 tick and is still running at 520 (ticks at 400 and 500 skip).
    await vi.advanceTimersByTimeAsync(520)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(root.api.feed.isFetching.value).toBe(true)
  })

  test('a failing interval refetch settles the entry in error and keeps its pages', async () => {
    vi.useFakeTimers()
    let calls = 0
    const inf = defineInfiniteQuery({
      id: 'cov-client/inf-interval-fail',
      key: () => ['feed'],
      fetcher: async ({ pageParam }) => {
        calls += 1
        if (calls > 1) throw new Error('poll failed')
        return page(pageParam)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchInterval: 100,
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
    expect(root.api.feed.status.value).toBe('success')
    await vi.advanceTimersByTimeAsync(100)
    expect(root.api.feed.status.value).toBe('error')
    expect((root.api.feed.error.value as Error).message).toBe('poll failed')
    expect(root.api.feed.pages.value).toEqual([page(0)])
  })
})
