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
