import { afterEach, describe, expect, test } from 'vitest'
import { defaultChannelFactory } from '../src/channel'

const originalBC = globalThis.BroadcastChannel

afterEach(() => {
  ;(globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = originalBC
})

describe('defaultChannelFactory', () => {
  test('returns undefined when BroadcastChannel is absent', () => {
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
    expect(defaultChannelFactory('any')).toBeUndefined()
  })

  test('round-trips messages via a real BroadcastChannel', async () => {
    // Node 17+ ships BroadcastChannel globally.
    const a = defaultChannelFactory('olas-test-channel')
    const b = defaultChannelFactory('olas-test-channel')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (!a || !b) return

    const received = await new Promise<unknown>((resolve) => {
      b.addEventListener('message', (e) => {
        resolve(e.data)
      })
      a.postMessage({ hi: 1 })
    })
    expect(received).toEqual({ hi: 1 })

    // Listener removal is reachable.
    const noop = () => {}
    b.addEventListener('message', noop)
    b.removeEventListener('message', noop)

    a.close()
    b.close()
  })
})
