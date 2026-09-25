// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController, type PluginHost } from '../src'

function rootWithHost() {
  let host: PluginHost | undefined
  const root = createRoot(
    defineController(() => ({})),
    {
      deps: {},
      plugins: [
        {
          name: 'network-watcher',
          setup(h) {
            host = h
          },
        },
      ],
    },
  )
  if (host === undefined) throw new Error('setup did not run')
  return { root, host }
}

describe('host.network', () => {
  test('onReconnect fires on the window online event until unsubscribed', () => {
    const { root, host } = rootWithHost()
    const reconnect = vi.fn()
    const off = host.network.onReconnect(reconnect)
    window.dispatchEvent(new Event('online'))
    expect(reconnect).toHaveBeenCalledTimes(1)
    off()
    window.dispatchEvent(new Event('online'))
    expect(reconnect).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('onFocus fires on window focus, and the root dispose unsubscribes it', async () => {
    const { root, host } = rootWithHost()
    const focus = vi.fn()
    host.network.onFocus(focus)
    window.dispatchEvent(new Event('focus'))
    // Focus notifications are coalesced into one microtask.
    await Promise.resolve()
    expect(focus).toHaveBeenCalledTimes(1)
    root.dispose()
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  test('isOnline follows navigator.onLine', () => {
    const { root, host } = rootWithHost()
    expect(host.network.isOnline()).toBe(true)
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      expect(host.network.isOnline()).toBe(false)
    } finally {
      onLine.mockRestore()
    }
    root.dispose()
  })
})
