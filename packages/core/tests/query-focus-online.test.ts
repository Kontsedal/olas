// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createCache, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { Entry } from '../src/query/entry'
import { signal } from '../src/signals'

const emptyDeps = {}

describe('refetchOnWindowFocus', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('refetches on window focus when data is stale', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/16',
      key: () => ['rfwf'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    root.dispose()
  })

  test('skips refetch when data is still fresh (within staleTime)', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/35',
      key: () => ['rfwf-fresh'],
      fetcher: async () => ++count,
      staleTime: 5000,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    await vi.advanceTimersByTimeAsync(5001)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    root.dispose()
  })

  test('does not refetch when flag is unset (default)', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/60',
      key: () => ['rfwf-off'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    root.dispose()
  })

  test('unsubscribes when subscriber count drops to 0', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/78',
      key: () => ['rfwf-unsub'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
      gcTime: 0,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    root.dispose()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)
  })

  test('responds to document visibilitychange (visible)', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/97',
      key: () => ['rfwf-vis'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    root.dispose()
  })
})

describe('refetchOnReconnect', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('refetches on online event when data is stale', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/125',
      key: () => ['rfr'],
      fetcher: async () => ++count,
      refetchOnReconnect: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    root.dispose()
  })

  test('does not refetch when flag is unset (default)', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/144',
      key: () => ['rfr-off'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    root.dispose()
  })

  test('both flags can coexist on the same query', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/162',
      key: () => ['both'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(3)

    root.dispose()
  })
})

describe('root-wide defaults', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('root refetchOnWindowFocus applies to queries that do not set it', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/191',
      key: () => ['root-wide-focus'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { refetchOnWindowFocus: true } }),
      deps: emptyDeps,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    root.dispose()
  })

  test('root refetchOnReconnect applies to queries that do not set it', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/213',
      key: () => ['root-wide-reconnect'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { refetchOnReconnect: true } }),
      deps: emptyDeps,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    root.dispose()
  })

  test('spec false beats root true (explicit per-query opt-out)', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/235',
      key: () => ['opt-out'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: false,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine({ defaults: { refetchOnWindowFocus: true } }),
      deps: emptyDeps,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    root.dispose()
  })

  test('spec true wins when root default is unset', async () => {
    // Sanity: verifies the resolution order doesn't accidentally clobber spec true.
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/259',
      key: () => ['spec-only'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(2)

    root.dispose()
  })
})

// R-Q3.5 (T3.5) — networkMode: 'offlineFirst' must actually park a network
// failure that happens while offline (not surface it), resume on reconnect, and
// expose the parked state via the new `isPaused` signal. The online-mode
// offline-defer path also sets `isPaused`. Real timers: this is event- and
// promise-driven, no timers involved.
describe('networkMode: offlineFirst + isPaused (R-Q3.5)', () => {
  const setOnline = (v: boolean): void => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
  }
  afterEach(() => setOnline(true))

  test('parks a network failure while offline; resumes to success on reconnect', async () => {
    setOnline(false)
    let attempt = 0
    const q = defineQuery({
      id: 'query-focus-online/291',
      key: () => ['of'],
      networkMode: 'offlineFirst',
      fetcher: async () => {
        attempt += 1
        if (attempt === 1) throw new TypeError('Failed to fetch')
        return 42
      },
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    // The initial fetch throws a network error while offline → parked, not errored.
    await vi.waitFor(() => expect(root.api.x.isPaused.value).toBe(true))
    expect(root.api.x.status.value).toBe('idle')
    expect(root.api.x.error.value).toBeUndefined()
    expect(root.api.x.isFetching.value).toBe(false)

    // Reconnect → retry → success; isPaused clears.
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(42))
    expect(root.api.x.status.value).toBe('success')
    expect(root.api.x.isPaused.value).toBe(false)

    root.dispose()
  })

  test('online mode: an offline-deferred fetch sets isPaused, cleared on reconnect', async () => {
    setOnline(false)
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/322',
      key: () => ['on-defer'],
      fetcher: async () => ++count, // networkMode defaults to 'online'
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    // Deferred while offline: the fetcher never ran, entry parked at idle.
    await vi.waitFor(() => expect(root.api.x.isPaused.value).toBe(true))
    expect(root.api.x.status.value).toBe('idle')
    expect(count).toBe(0)

    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(1))
    expect(root.api.x.isPaused.value).toBe(false)

    root.dispose()
  })
})

// R-Q3.9 (T3.9) — a tab-return fires BOTH `focus` and `visibilitychange`, which
// both trigger the focus-refetch fan-out. They must coalesce into a single
// refetch (microtask debounce), and triggerEventRefetch must join an in-flight
// fetch rather than abort+restart it.
describe('focus double-fire coalesces to one refetch (R-Q3.9)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('focus + visibilitychange in one tick refetch once, not twice', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/353',
      key: () => ['dblfire'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
      staleTime: 0, // always stale → focus refetches
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)

    // Both events collapse into a single refetch (was 3 before: two fires, the
    // second aborting + restarting the first).
    expect(count).toBe(2)
    root.dispose()
  })
})

// The hidden-tab gate on `refetchInterval` shipped untested — nothing in the
// suite ever set `visibilityState` to `'hidden'`. It lives here because these
// are the only jsdom-environment query tests. The second assertion in each case
// is the load-bearing one: the timer is a self-rescheduling `setTimeout` chain,
// so a skipped tick that forgot to re-arm would end polling permanently.
describe('refetchInterval — hidden tab', () => {
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  test('number form: hidden ticks are skipped, and the chain survives them', async () => {
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/394',
      key: () => ['rfi-hidden'],
      fetcher: async () => ++count,
      refetchInterval: 1000,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(1)

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(2)

    root.dispose()
  })

  test('function form: a hidden tick still re-resolves the next gap', async () => {
    const seen: Array<number | undefined> = []
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/420',
      key: () => ['rfi-hidden-fn'],
      fetcher: async () => ++count,
      refetchInterval: (data) => {
        seen.push(data)
        return 1000
      },
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)
    expect(seen).toEqual([undefined])

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(2000)
    // No fetches while hidden, but the thunk ran on both ticks — the chain is
    // alive and still asking for the next gap.
    expect(count).toBe(1)
    expect(seen).toEqual([undefined, 1, 1])

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(2)

    root.dispose()
  })
})

describe('reconnect dispatch', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
  })

  test('an online event while navigator still reports offline defers once, and does not spin', async () => {
    let reads = 0
    // Offline for the first 1,000 reads, so a spin terminates instead of hanging.
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => ++reads > 1_000 })
    let count = 0
    const q = defineQuery({
      id: 'query-focus-online/reconnect-spin',
      key: () => [],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.x.isPaused.value).toBe(true)
    const before = reads
    window.dispatchEvent(new Event('online'))
    // The drain re-checks the network once, parks again, and waits for the next event.
    expect(reads - before).toBeLessThan(10)
    expect(root.api.x.isPaused.value).toBe(true)
    expect(count).toBe(0)
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(1))
    root.dispose()
  })

  test('a subscriber removed during a dispatch does not fire in that dispatch', async () => {
    const { subscribeReconnect } = await import('../src/query/focus-online')
    const fired: string[] = []
    let offB = (): void => {}
    const offA = subscribeReconnect(() => {
      fired.push('a')
      offB()
    })
    offB = subscribeReconnect(() => fired.push('b'))
    window.dispatchEvent(new Event('online'))
    expect(fired).toEqual(['a'])
    offA()
  })
})

describe('a fetch requested offline supersedes the one in flight', () => {
  // In `online` mode a fetch requested while offline parks. It used to park
  // without superseding the fetch already running, so that older response
  // still landed. On a local cache whose key changed, the old key's data
  // showed under the new key (§5.5, §5.6).
  const setOnline = (v: boolean): void => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
  }
  afterEach(() => setOnline(true))

  test("the reviewer reproduction: a local cache does not show the old key's data", async () => {
    const key = signal('A')
    const pending: Array<(v: string) => void> = []
    const def = defineController((ctx) => ({
      c: createCache(
        ctx,
        () => {
          const k = key.peek()
          return new Promise<string>((r) => {
            pending.push(() => r(`data for ${k}`))
          })
        },
        { key: () => [key.value] },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(pending).toHaveLength(1)
    setOnline(false)
    key.set('B')
    expect(root.api.c.isPaused.value).toBe(true)
    // A's response arrives after the key moved on.
    pending[0]?.('')
    await vi.waitFor(() => expect(root.api.c.isFetching.value).toBe(false))
    await Promise.resolve()
    expect(root.api.c.data.value).toBeUndefined()
    // Reconnect fetches B.
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]?.('')
    await vi.waitFor(() => expect(root.api.c.data.value).toBe('data for B'))
    root.dispose()
  })

  test('a shared query: an offline refetch drops the response already on its way', async () => {
    let calls = 0
    const pending: Array<(v: number) => void> = []
    const q = defineQuery({
      id: 'query-focus-online/offline-supersede',
      key: () => [],
      fetcher: () => {
        calls += 1
        return new Promise<number>((r) => pending.push(r))
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(calls).toBe(1)
    setOnline(false)
    const refetched = root.api.x.refetch()
    expect(root.api.x.isPaused.value).toBe(true)
    expect(root.api.x.isFetching.value).toBe(false)
    pending[0]?.(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(root.api.x.data.value).toBeUndefined()
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(calls).toBe(2))
    pending[1]?.(2)
    await expect(refetched).resolves.toBe(2)
    root.dispose()
  })
})

describe('offline and reconnect scheduling', () => {
  const setOnline = (v: boolean): void => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
  }
  afterEach(() => {
    setOnline(true)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('interval ticks while parked do not park again', async () => {
    vi.useFakeTimers()
    const parks = vi.spyOn(Entry.prototype as never, 'scheduleDeferredFetch')
    let calls = 0
    const q = defineQuery({
      id: 'query-focus-online/offline-ticks',
      key: () => [],
      fetcher: async () => ++calls,
      refetchInterval: 1000,
    })
    setOnline(false)
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(parks).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(parks).toHaveBeenCalledTimes(1)
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    root.dispose()
  })

  test('refetchOnReconnect: one online event makes one request, not two', async () => {
    let calls = 0
    let aborts = 0
    const q = defineQuery({
      id: 'query-focus-online/reconnect-once',
      key: () => [],
      fetcher: ({ signal: s }) => {
        calls += 1
        s.addEventListener('abort', () => {
          aborts += 1
        })
        return Promise.resolve(calls)
      },
      refetchOnReconnect: true,
    })
    setOnline(false)
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(root.api.x.isPaused.value).toBe(true)
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(1))
    expect(calls).toBe(1)
    expect(aborts).toBe(0)
    root.dispose()
  })

  // The interval, focus and reconnect triggers skipped a parked entry and left
  // it to the entry's own `online` listener. When that event came while
  // `navigator.onLine` still read false, or never came at all, the entry stayed
  // parked for good. A parked entry that is online again now runs its fetch.
  test('an online event that arrives early does not strand the park: the next tick runs it', async () => {
    vi.useFakeTimers()
    let calls = 0
    const q = defineQuery({
      id: 'query-focus-online/park-early-online',
      key: () => [],
      fetcher: async () => ++calls,
      refetchInterval: 1000,
    })
    setOnline(false)
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(root.api.x.isPaused.value).toBe(true)
    // The event fires before `navigator.onLine` flips.
    window.dispatchEvent(new Event('online'))
    setOnline(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)
    expect(root.api.x.isPaused.value).toBe(false)
    expect(root.api.x.data.value).toBe(1)
    root.dispose()
  })

  test('a focus event runs a parked fetch once the network is back', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'query-focus-online/park-focus',
      key: () => [],
      fetcher: async () => ++calls,
      staleTime: 60_000,
      refetchOnWindowFocus: true,
    })
    setOnline(false)
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const refetched = root.api.x.refetch()
    expect(root.api.x.isPaused.value).toBe(true)
    setOnline(true)
    window.dispatchEvent(new Event('focus'))
    await expect(refetched).resolves.toBe(1)
    expect(calls).toBe(1)
    expect(root.api.x.isPaused.value).toBe(false)
    root.dispose()
  })

  // A parked infinite fetch is settled by the reconnect drain, which resolved
  // its waiters with no value. `prefetch` then resolved `undefined` instead of
  // the first page (§5.7).
  test('an infinite prefetch requested offline resolves with the first page', async () => {
    const q = defineInfiniteQuery({
      id: 'query-focus-online/prefetch-infinite-offline',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => `page ${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    setOnline(false)
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const prefetched = root.bindQuery(q).prefetch()
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await expect(prefetched).resolves.toBe('page 0')
    root.dispose()
  })

  test('an offlineFirst infinite prefetch parked by a network error resolves with the first page', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'query-focus-online/prefetch-infinite-offline-first',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls += 1
        if (calls === 1) {
          setOnline(false)
          throw new TypeError('Failed to fetch')
        }
        return `page ${pageParam}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      networkMode: 'offlineFirst',
    })
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const prefetched = root.bindQuery(q).prefetch()
    await vi.waitFor(() => expect(calls).toBe(1))
    await Promise.resolve()
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await expect(prefetched).resolves.toBe('page 0')
    root.dispose()
  })

  test('an infinite query: the next tick runs a parked fetch', async () => {
    vi.useFakeTimers()
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'query-focus-online/park-early-online-infinite',
      key: () => [],
      fetcher: async () => ++calls,
      initialPageParam: 0,
      getNextPageParam: () => null,
      refetchInterval: 1000,
    })
    setOnline(false)
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    expect(root.api.x.isPaused.value).toBe(true)
    window.dispatchEvent(new Event('online'))
    setOnline(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)
    expect(root.api.x.isPaused.value).toBe(false)
    expect(root.api.x.pages.value).toEqual([1])
    root.dispose()
  })
})
