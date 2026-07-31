// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'

const emptyDeps = {}

describe('refetchOnWindowFocus', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('refetches on window focus when data is stale', async () => {
    let count = 0
    const q = defineQuery({
      key: () => ['rfwf'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfwf-fresh'],
      fetcher: async () => ++count,
      staleTime: 5000,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfwf-off'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfwf-unsub'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
      gcTime: 0,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfwf-vis'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfr'],
      fetcher: async () => ++count,
      refetchOnReconnect: true,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfr-off'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['both'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['root-wide-focus'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps, refetchOnWindowFocus: true })
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
      key: () => ['root-wide-reconnect'],
      fetcher: async () => ++count,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps, refetchOnReconnect: true })
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
      key: () => ['opt-out'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: false,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps, refetchOnWindowFocus: true })
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
      key: () => ['spec-only'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['of'],
      networkMode: 'offlineFirst',
      fetcher: async () => {
        attempt += 1
        if (attempt === 1) throw new TypeError('Failed to fetch')
        return 42
      },
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })

    // The initial fetch throws a network error while offline → parked, not errored.
    await vi.waitFor(() => expect(root.x.isPaused.value).toBe(true))
    expect(root.x.status.value).toBe('idle')
    expect(root.x.error.value).toBeUndefined()
    expect(root.x.isFetching.value).toBe(false)

    // Reconnect → retry → success; isPaused clears.
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(root.x.data.value).toBe(42))
    expect(root.x.status.value).toBe('success')
    expect(root.x.isPaused.value).toBe(false)

    root.dispose()
  })

  test('online mode: an offline-deferred fetch sets isPaused, cleared on reconnect', async () => {
    setOnline(false)
    let count = 0
    const q = defineQuery({
      key: () => ['on-defer'],
      fetcher: async () => ++count, // networkMode defaults to 'online'
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })

    // Deferred while offline: the fetcher never ran, entry parked at idle.
    await vi.waitFor(() => expect(root.x.isPaused.value).toBe(true))
    expect(root.x.status.value).toBe('idle')
    expect(count).toBe(0)

    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(root.x.data.value).toBe(1))
    expect(root.x.isPaused.value).toBe(false)

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
      key: () => ['dblfire'],
      fetcher: async () => ++count,
      refetchOnWindowFocus: true,
      staleTime: 0, // always stale → focus refetches
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfi-hidden'],
      fetcher: async () => ++count,
      refetchInterval: 1000,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
      key: () => ['rfi-hidden-fn'],
      fetcher: async () => ++count,
      refetchInterval: (data) => {
        seen.push(data)
        return 1000
      },
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
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
