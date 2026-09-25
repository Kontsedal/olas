/**
 * `query/focus-online.ts` outside a browser. In Node there is no `window`, so
 * the focus and reconnect options must stay inert and their teardown safe
 * (spec §5.9, "SSR-safe"). A global `window` without a `document` still gets
 * the focus listener, just not the visibility one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createQuery, createRoot, defineController, defineQuery, queryEngine } from '../src'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('focus and reconnect triggers without a browser', () => {
  test('without window, the options are inert and releasing the subscription is safe', async () => {
    expect(typeof window).toBe('undefined')
    const fetcher = vi.fn(async () => 'server')
    const q = defineQuery({
      id: 'cov-no-window/inert',
      key: () => ['k'],
      fetcher,
      staleTime: 60_000, // so the only possible refetches are the triggers
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = createRoot(
      defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
      { queries: queryEngine(), deps: {} },
    )
    const opened = root.api.open()
    await root.waitForIdle()
    expect(opened.api.s.data.value).toBe('server')
    expect(() => opened.dispose()).not.toThrow()
    // A second subscribe/release cycle behaves the same.
    const again = root.api.open()
    await root.waitForIdle()
    expect(() => again.dispose()).not.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('a window without a document still refetches on focus, and stops once released', async () => {
    const fakeWindow = new EventTarget()
    vi.stubGlobal('window', fakeWindow)
    expect(typeof document).toBe('undefined')
    let calls = 0
    const q = defineQuery({
      id: 'cov-no-window/no-document',
      key: () => ['k'],
      fetcher: async () => ++calls,
      refetchOnWindowFocus: true,
    })
    const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = createRoot(
      defineController((ctx) => ({ open: () => ctx.attach(child, undefined) })),
      { queries: queryEngine(), deps: {} },
    )
    const opened = root.api.open()
    await root.waitForIdle()
    expect(calls).toBe(1)

    fakeWindow.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(calls).toBe(2))

    opened.dispose()
    fakeWindow.dispatchEvent(new Event('focus'))
    await root.waitForIdle()
    await Promise.resolve()
    expect(calls).toBe(2)
    root.dispose()
  })

  // A worker has `navigator.onLine` but no `window`, so no `online` event ever
  // reaches the entry's reconnect listener. The interval used to skip a parked
  // entry and wait for that event, and the entry stayed parked for good (§5.9).
  test('without window, a parked fetch runs on the next interval tick once online', async () => {
    vi.useFakeTimers()
    let onLine = false
    vi.stubGlobal('navigator', {
      get onLine() {
        return onLine
      },
    })
    try {
      let calls = 0
      const q = defineQuery({
        id: 'cov-no-window/park-interval',
        key: () => ['k'],
        fetcher: async () => ++calls,
        refetchInterval: 1000,
      })
      const root = createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      )
      expect(root.api.s.isPaused.value).toBe(true)
      await vi.advanceTimersByTimeAsync(3000)
      expect(calls).toBe(0)
      onLine = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toBe(1)
      expect(root.api.s.isPaused.value).toBe(false)
      expect(root.api.s.data.value).toBe(1)
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
