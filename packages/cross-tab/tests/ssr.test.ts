import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { defaultChannelFactory } from '../src/channel'
import { crossTabPlugin } from '../src/plugin'

/**
 * Server-safety contract. Node (every supported version), Bun and Deno all
 * define a global `BroadcastChannel`, and there it reaches every root in the
 * process, and other worker threads or isolates too. A server that builds a
 * root per request would deliver one user's writes into another user's
 * render. So the default factory opens a channel only in a browser scope: a
 * document, or a web worker. Anywhere else the plugin installs no hooks and
 * the root boots with cross-tab off.
 *
 * This file runs in vitest's Node environment, which has a real
 * `BroadcastChannel` and no `document`.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

type User = { id: string; name: string }

/** A stand-in `WorkerGlobalScope` that the global object is an instance of, as in a worker. */
const workerScope = (): unknown =>
  Object.defineProperty(() => {}, Symbol.hasInstance, { value: (v: unknown) => v === globalThis })

let counter = 0

/** One request root, built the way a server renders: a fresh root per request. */
function requestRoot(channelName: string, id: string, userName: string) {
  const me = defineQuery({
    id,
    meta: { crossTab: true },
    key: () => ['me'],
    fetcher: async (): Promise<User> => ({ id: 'me', name: userName }),
    staleTime: 60_000,
  })
  const root = createRoot(
    defineController((ctx) => ({ me: createQuery(ctx, me) })),
    { queries: queryEngine(), deps: {}, plugins: [crossTabPlugin({ channelName })] },
  )
  return { root, me }
}

describe('crossTabPlugin on a server', () => {
  test('Node has a global BroadcastChannel, and the default factory still opens none', () => {
    expect(typeof BroadcastChannel).toBe('function')
    expect(defaultChannelFactory('ssr/probe')).toBeUndefined()
  })

  test("two request roots in one process never see each other's writes", async () => {
    const channelName = `ssr/leak/${Date.now()}`
    const id = `ssr/me/${++counter}`
    const alice = requestRoot(channelName, id, 'Alice')
    const bob = requestRoot(channelName, id, 'Bob')
    try {
      await alice.root.waitForIdle()
      await bob.root.waitForIdle()
      alice.root.bindQuery(alice.me).write(() => ({ id: 'me', name: 'Alice, edited' }))
      // A real channel delivers on a later task; give it several.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10))
      expect(alice.root.api.me.data.peek()).toEqual({ id: 'me', name: 'Alice, edited' })
      expect(bob.root.api.me.data.peek()).toEqual({ id: 'me', name: 'Bob' })
    } finally {
      alice.root.dispose()
      bob.root.dispose()
    }
  })

  test('a Deno or Bun worker opens no channel either', () => {
    // A worker there has a `WorkerGlobalScope`, like a browser worker, but its
    // channel still crosses the server's isolates.
    vi.stubGlobal('WorkerGlobalScope', workerScope())
    vi.stubGlobal('Deno', {})
    expect(defaultChannelFactory('ssr/deno')).toBeUndefined()
    vi.unstubAllGlobals()
    vi.stubGlobal('WorkerGlobalScope', workerScope())
    vi.stubGlobal('Bun', {})
    expect(defaultChannelFactory('ssr/bun')).toBeUndefined()
  })

  test('an explicit channelFactory opts in anywhere', async () => {
    const opened: string[] = []
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [
          crossTabPlugin({
            channelName: 'ssr/explicit',
            channelFactory: (name) => {
              opened.push(name)
              return new BroadcastChannel(name)
            },
          }),
        ],
      },
    )
    expect(opened).toEqual(['ssr/explicit'])
    root.dispose()
  })

  test('returns a no-op plugin when channelFactory returns undefined', () => {
    const def = defineController(() => ({}))
    expect(() =>
      createRoot(def, {
        queries: queryEngine(),
        deps: {},
        plugins: [crossTabPlugin({ channelName: 'unused', channelFactory: () => undefined })],
      }).dispose(),
    ).not.toThrow()
  })

  test('no-op plugin does not log onWarn during normal operation', () => {
    const onWarn = vi.fn()
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [
        crossTabPlugin({
          channelName: 'unused',
          channelFactory: () => undefined,
          onWarn,
        }),
      ],
    })
    root.dispose()
    expect(onWarn).not.toHaveBeenCalled()
  })
})

describe('crossTabPlugin in a browser worker', () => {
  test('a web worker scope with no document opens a channel', () => {
    vi.stubGlobal('WorkerGlobalScope', workerScope())
    const channel = defaultChannelFactory('ssr/worker')
    expect(channel).toBeDefined()
    channel?.close()
  })
})
