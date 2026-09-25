// @vitest-environment jsdom
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  type Query,
  queryEngine,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { defaultChannelFactory } from '../src/channel'
import { crossTabPlugin } from '../src/plugin'

/**
 * The default factory in a browser tab. jsdom supplies the `document` that
 * marks one; the `BroadcastChannel` is Node's. `ssr.test.ts` covers the
 * server side, where the factory opens nothing.
 */

const originalBC = globalThis.BroadcastChannel

afterEach(() => {
  ;(globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = originalBC
})

type User = { id: string; name: string }

describe('defaultChannelFactory', () => {
  test('returns undefined when BroadcastChannel is absent', () => {
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
    expect(defaultChannelFactory('any')).toBeUndefined()
  })

  test('round-trips messages via a real BroadcastChannel', async () => {
    expect(typeof document).toBe('object')
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

describe('crossTabPlugin — default channel factory', () => {
  test('without a channelFactory, two roots sync over the platform BroadcastChannel', async () => {
    const channelName = `xtab-channel/real/${Date.now()}`
    // One query value per "tab", sharing only the id — as two real tabs would.
    const userQuery = () =>
      defineQuery({
        id: 'xtab-channel/user',
        meta: { crossTab: true },
        key: (userId: string) => ['user', userId],
        fetcher: async (_ctx, userId: string): Promise<User> => ({ id: userId, name: 'fetcher' }),
        staleTime: 60_000,
      })
    const a = userQuery()
    const b = userQuery()
    const mk = (q: Query<[string], User>) =>
      createRoot(
        defineController((ctx) => ({ user: createQuery(ctx, q, () => ['1' as string]) })),
        { queries: queryEngine(), deps: {}, plugins: [crossTabPlugin({ channelName })] },
      )
    const tabA = mk(a)
    const tabB = mk(b)
    try {
      await vi.waitFor(
        () => expect(tabB.api.user.data.peek()).toEqual({ id: '1', name: 'fetcher' }),
        { interval: 5, timeout: 1000 },
      )
      a.setData('1', () => ({ id: '1', name: 'over the wire' }))
      await vi.waitFor(
        () => expect(tabB.api.user.data.peek()).toEqual({ id: '1', name: 'over the wire' }),
        { interval: 5, timeout: 1000 },
      )
    } finally {
      tabA.dispose()
      tabB.dispose()
    }
  })
})
