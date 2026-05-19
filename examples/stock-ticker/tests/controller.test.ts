// Controller tests for the stock-ticker example.
//
// These run in plain Node (no jsdom), illustrating that everything important
// about an Olas controller is unit-testable without a DOM. We use the official
// `@olas/core/testing` helper to build an isolated root that wraps the
// controller, then assert on signal values directly.

import { createTestController } from '@olas/core/testing'
import type { StorageAdapter } from '@olas/persist'
import { describe, expect, test, vi } from 'vitest'
import { createFakeMarket } from '../src/api'
import { tickerController } from '../src/controller'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// In-memory storage adapter — same shape as @olas/persist's localStorageAdapter
// but synchronous and assertable.
const memoryStorage = (
  initial: Record<string, string> = {},
): StorageAdapter & { store: Map<string, string> } => {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => {
      store.set(k, v)
    },
    delete: (k) => {
      store.delete(k)
    },
  }
}

describe('tickerController', () => {
  test('emitter ticks update the prices signal', async () => {
    const market = createFakeMarket({ autoTick: false })
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 0 },
      deps: { market, storage: memoryStorage() },
    })
    await flush()

    market.tick('AAPL', 200)
    expect(root.prices.value).toEqual({ AAPL: 200 })

    market.tick('AAPL', 201.5)
    expect(root.prices.value).toEqual({ AAPL: 201.5 })

    root.dispose()
  })

  test('changing the watchlist resubscribes the market (effect re-runs)', async () => {
    const market = createFakeMarket({ autoTick: false })
    const subscribeSpy = vi.spyOn(market, 'subscribe')

    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 0 },
      deps: { market, storage: memoryStorage() },
    })
    await flush()

    // Initial subscription for AAPL.
    expect(subscribeSpy).toHaveBeenCalledWith('AAPL', expect.any(Function))
    const initialCalls = subscribeSpy.mock.calls.length

    // Mutate watchlist — effect re-runs, old unsub fires, new subscribes happen.
    root.watchlist.set(['MSFT', 'NVDA'])
    await flush()
    expect(subscribeSpy.mock.calls.length).toBeGreaterThan(initialCalls)
    expect(subscribeSpy).toHaveBeenCalledWith('MSFT', expect.any(Function))
    expect(subscribeSpy).toHaveBeenCalledWith('NVDA', expect.any(Function))

    // Old symbol should be gone — ticks for it stop reaching the prices map.
    market.tick('AAPL', 999)
    expect(root.prices.value.AAPL ?? 0).toBe(0)

    root.dispose()
  })

  test('throttled prices coalesce rapid ticks within the window', async () => {
    vi.useFakeTimers()
    const market = createFakeMarket({ autoTick: false })
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 100 },
      deps: { market, storage: memoryStorage() },
    })
    // flush is microtask-based; with fake timers we still need it.
    await Promise.resolve()
    await Promise.resolve()

    const seen: Record<string, number>[] = []
    const unsub = root.pricesThrottled.subscribe((v) => seen.push({ ...v }))

    // First tick — leading edge of the throttle window — should be visible.
    market.tick('AAPL', 100)
    // Two more ticks within the same 100ms window should not yet be flushed.
    market.tick('AAPL', 101)
    market.tick('AAPL', 102)

    // Advance past the throttle window — trailing edge fires with the latest.
    vi.advanceTimersByTime(150)

    // We expect: initial subscribe snapshot (empty), the leading tick (100),
    // then the trailing coalesced tick (102). 101 was swallowed.
    const aaplValues = seen.map((s) => s.AAPL).filter((v) => v !== undefined)
    expect(aaplValues).toContain(100)
    expect(aaplValues).toContain(102)
    expect(aaplValues).not.toContain(101)

    unsub()
    root.dispose()
    vi.useRealTimers()
  })

  test('debounced search fires once after rapid typing', async () => {
    vi.useFakeTimers()
    const market = createFakeMarket({ autoTick: false })
    const root = createTestController(tickerController, {
      props: { initialWatchlist: [], uiThrottleMs: 0, searchDebounceMs: 150 },
      deps: { market, storage: memoryStorage() },
    })
    await Promise.resolve()

    const seen: string[] = []
    const unsub = root.searchDebounced.subscribe((v) => seen.push(v))

    // Type rapidly within the debounce window.
    root.searchInput.set('a')
    root.searchInput.set('ap')
    root.searchInput.set('app')

    // Before the window elapses, only the initial subscribe value has fired.
    expect(seen).toEqual([''])

    vi.advanceTimersByTime(200)
    // After the window: exactly the latest value, not the intermediates.
    expect(seen).toEqual(['', 'app'])

    unsub()
    root.dispose()
    vi.useRealTimers()
  })

  test('watchlist persists to the injected storage adapter', async () => {
    const market = createFakeMarket({ autoTick: false })
    const storage = memoryStorage()
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 0 },
      deps: { market, storage },
    })
    await flush()

    root.watchlist.set(['AAPL', 'GOOG', 'NVDA'])
    expect(storage.store.get('olas-ticker.watchlist')).toBe(
      JSON.stringify(['AAPL', 'GOOG', 'NVDA']),
    )

    root.dispose()
  })

  test('persisted watchlist is restored on construction', async () => {
    const market = createFakeMarket({ autoTick: false })
    const storage = memoryStorage({
      'olas-ticker.watchlist': JSON.stringify(['TSLA', 'F']),
    })
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 0 },
      deps: { market, storage },
    })
    await flush()

    // The persisted value beats the constructor-supplied default.
    expect(root.watchlist.value).toEqual(['TSLA', 'F'])

    root.dispose()
  })

  test('addToWatchlist / removeFromWatchlist mutate the list (and persist)', async () => {
    const market = createFakeMarket({ autoTick: false })
    const storage = memoryStorage()
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 0 },
      deps: { market, storage },
    })
    await flush()

    root.addToWatchlist('GOOG')
    expect(root.watchlist.value).toEqual(['AAPL', 'GOOG'])
    // Adding the same symbol twice is a no-op.
    root.addToWatchlist('GOOG')
    expect(root.watchlist.value).toEqual(['AAPL', 'GOOG'])
    root.removeFromWatchlist('AAPL')
    expect(root.watchlist.value).toEqual(['GOOG'])

    // Persistence reflects the latest list.
    expect(storage.store.get('olas-ticker.watchlist')).toBe(JSON.stringify(['GOOG']))
    root.dispose()
  })

  test('price alert fires once when crossed and emits an alertFiredEmitter event', async () => {
    const market = createFakeMarket({ autoTick: false })
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 0 },
      deps: { market, storage: memoryStorage() },
    })
    await flush()

    const seen: Array<{ symbol: string; target: number; price: number }> = []
    root.alertFiredEmitter.on((ev) => {
      seen.push({ symbol: ev.alert.symbol, target: ev.alert.target, price: ev.price })
    })

    root.addAlert({ symbol: 'AAPL', direction: 'above', target: 150 })
    // First tick seeds history; alert evaluator requires a prev price.
    market.tick('AAPL', 100)
    expect(seen).toEqual([])

    // Cross 150 going up — fire.
    market.tick('AAPL', 160)
    expect(seen.length).toBe(1)
    expect(seen[0]).toMatchObject({ symbol: 'AAPL', target: 150 })

    // Further crossings should not refire (fired=true is sticky).
    market.tick('AAPL', 200)
    expect(seen.length).toBe(1)
    expect(root.alerts.value[0]!.fired).toBe(true)
    root.dispose()
  })

  test('history is bounded by historyCap', async () => {
    const market = createFakeMarket({ autoTick: false })
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL'], uiThrottleMs: 0, historyCap: 5 },
      deps: { market, storage: memoryStorage() },
    })
    await flush()

    for (let i = 0; i < 12; i++) market.tick('AAPL', 100 + i)
    expect(root.historyThrottled.value.AAPL!.length).toBe(5)
    // Latest five values.
    expect(root.historyThrottled.value.AAPL).toEqual([107, 108, 109, 110, 111])
    root.dispose()
  })

  test('portfolioTotal sums throttled prices for watched symbols only', async () => {
    const market = createFakeMarket({ autoTick: false })
    const root = createTestController(tickerController, {
      props: { initialWatchlist: ['AAPL', 'MSFT'], uiThrottleMs: 0 },
      deps: { market, storage: memoryStorage() },
    })
    await flush()

    market.tick('AAPL', 100)
    market.tick('MSFT', 200)
    market.tick('NVDA', 500) // not in watchlist — shouldn't count
    await flush()
    expect(root.portfolioTotal.value).toBeCloseTo(300, 2)

    root.dispose()
  })
})
