import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  type InvalidateEvent,
  type OlasPlugin,
  type Query,
  queryEngine,
  type WriteEvent,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type ChannelLike,
  CROSS_TAB_PLUGIN_NAME,
  type CrossTabOptions,
  crossTabPlugin,
  type Message,
  PROTOCOL_VERSION,
} from '../src/index'

/**
 * Edge coverage for `crossTabPlugin` (SPEC §13.2): the inbound guards
 * (malformed / foreign / echoed messages), the per-peer cursor cap, the
 * outbound size estimate, the origin gate and the default `onWarn`.
 * `channel.test.ts` covers the default `BroadcastChannel` factory.
 *
 * Most tests use a probe channel: it records what the plugin posts and lets
 * the test hand-deliver raw inbound messages, so each guard is exercised in
 * isolation from a second tab.
 */

type Listener = (event: { data: unknown }) => void
type User = { id: string; name: string }

function probeChannel() {
  const listeners = new Set<Listener>()
  const posted: unknown[] = []
  let closed = false
  const channel: ChannelLike = {
    postMessage(data) {
      posted.push(data)
    },
    addEventListener(_type, l) {
      listeners.add(l)
    },
    removeEventListener(_type, l) {
      listeners.delete(l)
    },
    close() {
      closed = true
    },
  }
  return {
    channel,
    posted,
    isClosed: () => closed,
    deliver(data: unknown) {
      for (const l of [...listeners]) l({ data })
    },
  }
}

/** A plugin that records every write and invalidation the root makes. */
function spyPlugin() {
  const writes: WriteEvent[] = []
  const invalidates: InvalidateEvent[] = []
  const plugin: OlasPlugin = {
    name: 'spy',
    setup: () => ({
      onWrite: (e) => {
        writes.push(e)
      },
      onInvalidate: (e) => {
        invalidates.push(e)
      },
    }),
  }
  return { plugin, writes, invalidates }
}

let queryCounter = 0

function makeQuery(
  fetcher = vi.fn(async (_ctx: unknown, id: string) => ({ id, name: 'fetcher' })),
) {
  const id = `xtab-cov/${++queryCounter}`
  const query: Query<[string], User> = defineQuery({
    id,
    meta: { crossTab: true },
    key: (userId: string) => ['user', userId],
    fetcher: (ctx, userId: string) => fetcher(ctx, userId),
    staleTime: 60_000,
  })
  return { id, query, fetcher }
}

function mount(options: Omit<CrossTabOptions, 'channelName' | 'channelFactory'> = {}) {
  const probe = probeChannel()
  const spy = spyPlugin()
  const { id, query, fetcher } = makeQuery()
  const def = defineController((ctx) => ({
    user: createQuery(ctx, query, () => ['1' as string]),
  }))
  const root = createRoot(def, {
    queries: queryEngine(),
    deps: {},
    plugins: [
      crossTabPlugin({ channelName: 'cov', channelFactory: () => probe.channel, ...options }),
      spy.plugin,
    ],
  })
  const peek = () => root.api.user.data.peek() as User | undefined
  /** Writes this root applied because a peer asked for them. */
  const remoteWrites = () => spy.writes.filter((w) => w.origin === CROSS_TAB_PLUGIN_NAME)
  return { root, probe, spy, id, query, fetcher, peek, remoteWrites }
}

function setDataMsg(
  queryId: string,
  sourceId: string,
  msgId: number,
  name: string,
  extra: Record<string, unknown> = {},
): Message {
  return {
    v: PROTOCOL_VERSION,
    type: 'setData',
    sourceId,
    msgId,
    queryId,
    keyArgs: ['user', '1'],
    data: { id: '1', name },
    ...extra,
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('crossTabPlugin — inbound guards', () => {
  test('a well-formed peer write lands, stamped with the plugin name as origin', async () => {
    const t = mount()
    await settle()
    t.probe.deliver(setDataMsg(t.id, 'peer', 1, 'from peer'))
    expect(t.peek()).toEqual({ id: '1', name: 'from peer' })
    expect(t.remoteWrites()).toHaveLength(1)
    expect(t.remoteWrites()[0]?.source).toBe('write')
    t.root.dispose()
  })

  test('non-object payloads are ignored without a warning', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn })
    await settle()
    for (const junk of [null, undefined, 'setData', 42, true]) t.probe.deliver(junk)
    expect(t.peek()).toEqual({ id: '1', name: 'fetcher' })
    expect(t.remoteWrites()).toHaveLength(0)
    expect(onWarn).not.toHaveBeenCalled()
    t.root.dispose()
  })

  test('a message without a string sourceId or a numeric msgId is dropped silently', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn })
    await settle()
    t.probe.deliver({ ...setDataMsg(t.id, 'peer', 1, 'no-source'), sourceId: 7 })
    t.probe.deliver({ ...setDataMsg(t.id, 'peer', 1, 'no-msgid'), msgId: '1' })
    const { sourceId: _s, ...withoutSource } = setDataMsg(t.id, 'peer', 1, 'missing')
    t.probe.deliver(withoutSource)
    expect(t.peek()).toEqual({ id: '1', name: 'fetcher' })
    expect(t.remoteWrites()).toHaveLength(0)
    expect(onWarn).not.toHaveBeenCalled()
    t.root.dispose()
  })

  test('a message with a bad queryId or keyArgs warns, naming its type, and is not applied', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn })
    await settle()
    t.probe.deliver({ ...setDataMsg(t.id, 'peer', 1, 'bad-id'), queryId: 12 })
    t.probe.deliver({ ...setDataMsg(t.id, 'peer', 2, 'bad-key'), keyArgs: 'user/1' })
    t.probe.deliver({
      v: PROTOCOL_VERSION,
      type: 'invalidate',
      sourceId: 'peer',
      msgId: 3,
      queryId: t.id,
    })
    expect(onWarn.mock.calls).toEqual([
      ['[olas/cross-tab] malformed setData message'],
      ['[olas/cross-tab] malformed setData message'],
      ['[olas/cross-tab] malformed invalidate message'],
    ])
    expect(t.peek()).toEqual({ id: '1', name: 'fetcher' })
    expect(t.spy.invalidates).toHaveLength(0)
    t.root.dispose()
  })

  test('a setData whose pageParams is not an array warns and is not applied', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn })
    await settle()
    t.probe.deliver(setDataMsg(t.id, 'peer', 1, 'bad-params', { pageParams: { 0: 1 } }))
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn).toHaveBeenCalledWith(
      '[olas/cross-tab] malformed setData message: pageParams is not an array',
    )
    expect(t.peek()).toEqual({ id: '1', name: 'fetcher' })
    expect(t.remoteWrites()).toHaveLength(0)
    t.root.dispose()
  })

  test('a message of an unknown type neither writes nor invalidates', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn })
    await settle()
    expect(t.fetcher).toHaveBeenCalledTimes(1)
    t.probe.deliver({ ...setDataMsg(t.id, 'peer', 1, 'deleted'), type: 'delete' })
    await settle()
    expect(t.peek()).toEqual({ id: '1', name: 'fetcher' })
    expect(t.remoteWrites()).toHaveLength(0)
    expect(t.spy.invalidates).toHaveLength(0)
    expect(t.fetcher).toHaveBeenCalledTimes(1)
    expect(onWarn).not.toHaveBeenCalled()
    t.root.dispose()
  })

  test("a transport that echoes the root's own message back is ignored", async () => {
    const t = mount()
    await settle()
    t.query.setData('1', () => ({ id: '1', name: 'local' }))
    expect(t.probe.posted).toHaveLength(1)
    const own = t.probe.posted[0] as Message

    // The echo carries this root's sourceId: dropped.
    t.probe.deliver(own)
    expect(t.remoteWrites()).toHaveLength(0)

    // The same message from any other source would have been applied.
    t.probe.deliver({ ...own, sourceId: 'someone-else', data: { id: '1', name: 'peer' } })
    expect(t.remoteWrites()).toHaveLength(1)
    expect(t.peek()).toEqual({ id: '1', name: 'peer' })
    t.root.dispose()
  })
})

describe('crossTabPlugin — per-peer cursor cap', () => {
  test('past 64 peers the oldest is forgotten and its cursor starts over', async () => {
    const t = mount()
    await settle()
    t.probe.deliver(setDataMsg(t.id, 'p0', 10, 'p0-10'))
    expect(t.peek()?.name).toBe('p0-10')

    // p0 is still tracked: an older msgId from it is a stale duplicate.
    t.probe.deliver(setDataMsg(t.id, 'p0', 1, 'p0-stale'))
    expect(t.peek()?.name).toBe('p0-10')

    // 64 more peers push the tracked set to 65: p0, the oldest, is evicted.
    for (let i = 1; i <= 64; i++) t.probe.deliver(setDataMsg(t.id, `p${i}`, 1, `p${i}`))
    expect(t.peek()?.name).toBe('p64')

    t.probe.deliver(setDataMsg(t.id, 'p0', 1, 'p0-again'))
    expect(t.peek()?.name).toBe('p0-again')
    t.root.dispose()
  })

  test('hearing from a peer again makes it the newest, so the next-oldest is evicted', async () => {
    const t = mount()
    await settle()
    t.probe.deliver(setDataMsg(t.id, 'p0', 10, 'p0-10'))
    for (let i = 1; i <= 63; i++) t.probe.deliver(setDataMsg(t.id, `p${i}`, 5, `p${i}`))
    // p0 speaks again: it moves to the back of the eviction order.
    t.probe.deliver(setDataMsg(t.id, 'p0', 11, 'p0-11'))
    // A 65th peer evicts p1, not p0.
    t.probe.deliver(setDataMsg(t.id, 'p64', 1, 'p64'))

    t.probe.deliver(setDataMsg(t.id, 'p0', 3, 'p0-stale'))
    expect(t.peek()?.name).toBe('p64')

    t.probe.deliver(setDataMsg(t.id, 'p1', 1, 'p1-restarted'))
    expect(t.peek()?.name).toBe('p1-restarted')
    t.root.dispose()
  })
})

describe('crossTabPlugin — outbound payload estimate', () => {
  test('an oversized payload warns and is still posted', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn, maxPayloadBytes: 32 })
    await settle()
    t.query.setData('1', () => ({ id: '1', name: 'a name long enough to cross the cap' }))
    expect(t.probe.posted).toHaveLength(1)
    const size = JSON.stringify(t.probe.posted[0]).length
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn).toHaveBeenCalledWith(
      `[olas/cross-tab] payload for setData queryId="${t.id}" is ${size} bytes, over the ` +
        '32-byte soft cap. Consider entities or thinner queries.',
    )
    t.root.dispose()
  })

  test('the default cap is 512 KB', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn })
    await settle()
    t.query.setData('1', () => ({ id: '1', name: 'x'.repeat(500 * 1024) }))
    expect(onWarn).not.toHaveBeenCalled()
    t.query.setData('1', () => ({ id: '1', name: 'x'.repeat(513 * 1024) }))
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toContain('over the 524288-byte soft cap')
    expect(t.probe.posted).toHaveLength(2)
    t.root.dispose()
  })

  test('maxPayloadBytes: Infinity turns the size warning off', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn, maxPayloadBytes: Number.POSITIVE_INFINITY })
    await settle()
    t.query.setData('1', () => ({ id: '1', name: 'x'.repeat(600 * 1024) }))
    expect(t.probe.posted).toHaveLength(1)
    expect(onWarn).not.toHaveBeenCalled()
    t.root.dispose()
  })

  test('a payload JSON cannot measure is posted without a size warning', async () => {
    const onWarn = vi.fn()
    const t = mount({ onWarn, maxPayloadBytes: 1 })
    await settle()
    // BigInt is structured-cloneable but not JSON-serializable.
    t.query.setData('1', () => ({ id: '1', name: 'big', n: 10n }) as unknown as User)
    expect(t.probe.posted).toHaveLength(1)
    expect((t.probe.posted[0] as { data: { n: bigint } }).data.n).toBe(10n)
    expect(onWarn).not.toHaveBeenCalled()
    t.root.dispose()
  })
})

describe('crossTabPlugin — origin gate', () => {
  test("listing the plugin's own name in origins still never re-broadcasts a peer write", async () => {
    const t = mount({ origins: [CROSS_TAB_PLUGIN_NAME] })
    await settle()
    t.probe.deliver(setDataMsg(t.id, 'peer', 1, 'from peer'))
    expect(t.peek()).toEqual({ id: '1', name: 'from peer' })
    expect(t.probe.posted).toHaveLength(0)

    // The app's own writes are still mirrored.
    t.query.setData('1', () => ({ id: '1', name: 'local' }))
    expect(t.probe.posted).toHaveLength(1)
    t.root.dispose()
  })
})

describe('crossTabPlugin — setup', () => {
  test('a root without a query engine fails to construct, before any channel opens', () => {
    const channelFactory = vi.fn(() => probeChannel().channel)
    const def = defineController(() => ({}))
    expect(() =>
      createRoot(def, {
        deps: {},
        plugins: [crossTabPlugin({ channelName: 'no-engine', channelFactory })],
      }),
    ).toThrow('[olas/cross-tab] crossTabPlugin needs a query engine')
    expect(channelFactory).not.toHaveBeenCalled()
  })

  test('dispose closes the channel and detaches the listener', async () => {
    const t = mount()
    await settle()
    t.root.dispose()
    expect(t.probe.isClosed()).toBe(true)
    t.probe.deliver(setDataMsg(t.id, 'peer', 1, 'late'))
    expect(t.remoteWrites()).toHaveLength(0)
  })
})

describe('crossTabPlugin — default onWarn', () => {
  test('a malformed message goes to console.warn with the message alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = mount()
    await settle()
    t.probe.deliver({ ...setDataMsg(t.id, 'peer', 1, 'bad'), keyArgs: null })
    const ours = warn.mock.calls.filter((c) => String(c[0]).startsWith('[olas/cross-tab]'))
    expect(ours).toEqual([['[olas/cross-tab] malformed setData message']])
    t.root.dispose()
  })

  test('a failed post goes to console.warn with its cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cause = new Error('DataCloneError')
    const listeners = new Set<Listener>()
    const channel: ChannelLike = {
      postMessage() {
        throw cause
      },
      addEventListener: (_type, l) => {
        listeners.add(l)
      },
      removeEventListener: (_type, l) => {
        listeners.delete(l)
      },
      close() {},
    }
    const { id, query } = makeQuery()
    const def = defineController((ctx) => ({
      user: createQuery(ctx, query, () => ['1' as string]),
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [crossTabPlugin({ channelName: 'throws', channelFactory: () => channel })],
    })
    await settle()
    query.setData('1', () => ({ id: '1', name: 'local' }))
    const ours = warn.mock.calls.filter((c) => String(c[0]).startsWith('[olas/cross-tab]'))
    expect(ours).toEqual([
      [
        `[olas/cross-tab] failed to broadcast setData for queryId="${id}": data is not structured-cloneable`,
        cause,
      ],
    ])
    // The sender's cache keeps the write.
    expect(root.api.user.data.peek()).toEqual({ id: '1', name: 'local' })
    root.dispose()
  })
})
