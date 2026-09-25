import {
  createQuery,
  createRoot,
  type DebugEvent,
  defineController,
  defineQuery,
  type Query,
  queryEngine,
} from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import {
  type ChannelLike,
  CROSS_TAB_PLUGIN_NAME,
  type CrossTabOptions,
  crossTabPlugin,
  type Message,
  PROTOCOL_VERSION,
} from '../src/index'

/**
 * The cross-tab plugin's devtools lane: every message it posts and every
 * message a peer sent on this protocol reach `host.debug`, which core delivers
 * as a `plugin:event` named after the plugin. Development builds only; vitest
 * runs with `__DEV__` on.
 */

type Listener = (event: { data: unknown }) => void
type User = { id: string; name: string }

/** The payloads on the cross-tab lane, in order. */
const lane = (events: DebugEvent[]): Array<Record<string, unknown>> =>
  events.flatMap((e) =>
    e.type === 'plugin:event' && e.plugin === CROSS_TAB_PLUGIN_NAME
      ? [e.payload as Record<string, unknown>]
      : [],
  )

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let queryCounter = 0

/** One query value per tab, sharing only the id, as two real tabs would. */
const userQuery = (id: string): Query<[string], User> =>
  defineQuery({
    id,
    meta: { crossTab: true },
    key: (userId: string) => ['user', userId],
    fetcher: async (_ctx, userId: string) => ({ id: userId, name: 'fetcher' }),
    staleTime: 60_000,
  })

/** A root on `channel`, with its debug events recorded from the start. */
function tab(
  query: Query<[string], User>,
  channel: ChannelLike,
  options: Omit<CrossTabOptions, 'channelName' | 'channelFactory'> = {},
) {
  const root = createRoot(
    defineController((ctx) => ({ user: createQuery(ctx, query, () => ['1' as string]) })),
    {
      queries: queryEngine(),
      deps: {},
      plugins: [crossTabPlugin({ channelName: 'lane', channelFactory: () => channel, ...options })],
    },
  )
  const events: DebugEvent[] = []
  root.debug.subscribe((e) => {
    events.push(e)
  })
  return { root, events }
}

/** A channel pair: what one posts, the other receives on the next microtask. */
function channelPair(): [ChannelLike, ChannelLike] {
  const listeners: [Set<Listener>, Set<Listener>] = [new Set(), new Set()]
  const end = (mine: Set<Listener>, theirs: Set<Listener>): ChannelLike => ({
    postMessage(data) {
      for (const l of theirs) queueMicrotask(() => l({ data }))
    },
    addEventListener: (_type, l) => {
      mine.add(l)
    },
    removeEventListener: (_type, l) => {
      mine.delete(l)
    },
    close: () => mine.clear(),
  })
  return [end(listeners[0], listeners[1]), end(listeners[1], listeners[0])]
}

/** A channel the test delivers to by hand, and whose posts can be made to throw. */
function probeChannel() {
  const listeners = new Set<Listener>()
  let throwing = false
  const channel: ChannelLike = {
    postMessage() {
      if (throwing) throw new Error('DataCloneError')
    },
    addEventListener: (_type, l) => {
      listeners.add(l)
    },
    removeEventListener: (_type, l) => {
      listeners.delete(l)
    },
    close() {},
  }
  return {
    channel,
    deliver(data: unknown) {
      for (const l of [...listeners]) l({ data })
    },
    throwOnPost() {
      throwing = true
    },
  }
}

describe('cross-tab devtools lane', () => {
  test('a mirrored write is a send in one tab and a receive in the other, named alike', async () => {
    const id = `xtab-lane/${++queryCounter}`
    const qA = userQuery(id)
    const [channelA, channelB] = channelPair()
    const a = tab(qA, channelA)
    const b = tab(userQuery(id), channelB)
    await settle()
    // Fetches are per tab: nothing crossed yet.
    expect(lane(a.events)).toEqual([])

    qA.setData('1', () => ({ id: '1', name: 'from A' }))
    qA.invalidate('1')
    await settle()

    const sent = lane(a.events)
    expect(sent).toEqual([
      {
        kind: 'send',
        type: 'setData',
        source: 'optimistic',
        queryId: id,
        outcome: 'posted',
        from: expect.any(String),
        msgId: 1,
        key: ['user', '1'],
      },
      {
        kind: 'send',
        type: 'invalidate',
        queryId: id,
        outcome: 'posted',
        from: sent[0]?.from,
        msgId: 2,
        key: ['user', '1'],
      },
    ])
    // The receiver names the message by the sender's id and counter.
    expect(lane(b.events)).toEqual([
      { ...sent[0], kind: 'receive', outcome: 'applied' },
      { ...sent[1], kind: 'receive', outcome: 'applied' },
    ])
    // The invalidate made B refetch.
    expect(b.root.api.user.data.peek()).toEqual({ id: '1', name: 'fetcher' })
    a.root.dispose()
    b.root.dispose()
  })

  test('a failed post is on the lane as not-cloneable', async () => {
    const id = `xtab-lane/${++queryCounter}`
    const q = userQuery(id)
    const probe = probeChannel()
    const t = tab(q, probe.channel, { onWarn: () => {} })
    await settle()
    probe.throwOnPost()
    q.setData('1', () => ({ id: '1', name: 'local' }))
    expect(lane(t.events)).toEqual([
      expect.objectContaining({ kind: 'send', type: 'setData', outcome: 'not-cloneable' }),
    ])
    t.root.dispose()
  })

  test('every way a peer message ends is on the lane, and the silent drops are not', async () => {
    const id = `xtab-lane/${++queryCounter}`
    const probe = probeChannel()
    const t = tab(userQuery(id), probe.channel, {
      onWarn: () => {},
      validate: (_queryId, data) => (data as User).name !== 'refused',
    })
    await settle()
    const msg = (msgId: number, extra: Record<string, unknown> = {}): Message =>
      ({
        v: PROTOCOL_VERSION,
        type: 'setData',
        sourceId: 'peer',
        msgId,
        queryId: id,
        keyArgs: ['user', '1'],
        data: { id: '1', name: 'from peer' },
        ...extra,
      }) as Message
    const cyclic: unknown[] = []
    cyclic.push(cyclic)

    probe.deliver(msg(1))
    probe.deliver(msg(1))
    probe.deliver(msg(2, { keyArgs: 'user/1' }))
    probe.deliver(msg(3, { queryId: 'xtab-lane/not-here' }))
    probe.deliver(msg(4, { data: { id: '1', name: 'refused' } }))
    probe.deliver(msg(5, { keyArgs: [cyclic] }))
    probe.deliver(msg(6, { type: 'delete' }))
    probe.deliver(msg(7, { msgId: -1 }))
    probe.deliver(msg(8, { type: 'invalidate' }))
    // Not a message, and another protocol version: silent.
    probe.deliver('junk')
    probe.deliver(msg(9, { v: PROTOCOL_VERSION + 1 }))

    expect(lane(t.events).map((p) => [p.msgId, p.type, p.outcome, p.from])).toEqual([
      [1, 'setData', 'applied', 'peer'],
      [1, 'setData', 'duplicate', 'peer'],
      [2, 'setData', 'malformed', 'peer'],
      [3, 'setData', 'ignored', 'peer'],
      [4, 'setData', 'rejected', 'peer'],
      [5, 'setData', 'failed', 'peer'],
      [6, 'delete', 'malformed', 'peer'],
      [-1, 'setData', 'malformed', 'peer'],
      [8, 'invalidate', 'applied', 'peer'],
    ])
    t.root.dispose()
  })
})
