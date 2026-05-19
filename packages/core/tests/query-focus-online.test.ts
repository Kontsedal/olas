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
