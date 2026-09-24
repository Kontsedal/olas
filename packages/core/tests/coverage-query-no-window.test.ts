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
})
