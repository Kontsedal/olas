/**
 * Any same-origin script can post on the channel. A hostile or broken message
 * must be reported through `onWarn`, never throw out of the listener, never
 * silence a real peer, and never reach the cache past `validate`.
 */
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import { type ChannelLike, crossTabPlugin, PROTOCOL_VERSION } from '../src/index'

type Listener = (event: { data: unknown }) => void

function probeChannel() {
  const listeners = new Set<Listener>()
  const channel: ChannelLike = {
    postMessage() {},
    addEventListener(_type, l) {
      listeners.add(l)
    },
    removeEventListener(_type, l) {
      listeners.delete(l)
    },
    close() {},
  }
  return {
    channel,
    deliver(data: unknown) {
      for (const l of [...listeners]) l({ data })
    },
  }
}

const setData = (msgId: number, keyArgs: unknown[], data: unknown, sourceId = 'peer-1') => ({
  v: PROTOCOL_VERSION,
  type: 'setData',
  sourceId,
  msgId,
  queryId: 'sec-ct/list',
  keyArgs,
  data,
})

async function tab(options: { validate?: (queryId: string, data: unknown) => boolean } = {}) {
  const probe = probeChannel()
  const onWarn = vi.fn()
  const list = defineQuery({
    id: 'sec-ct/list',
    key: () => [],
    fetcher: async () => ['a'],
    meta: { crossTab: true },
  })
  const root = createRoot(
    defineController((ctx) => ({ list: createQuery(ctx, list) })),
    {
      queries: queryEngine(),
      deps: {},
      plugins: [
        crossTabPlugin({
          channelName: 'sec-ct',
          channelFactory: () => probe.channel,
          onWarn,
          ...options,
        }),
      ],
    },
  )
  await root.waitForIdle()
  return { root, probe, onWarn }
}

describe('cross-tab receiving hostile messages', () => {
  test('a key the engine cannot hash is reported, not thrown out of the listener', async () => {
    const { root, probe, onWarn } = await tab()
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(() => probe.deliver(setData(1, cyclic, ['x']))).not.toThrow()
    expect(onWarn).toHaveBeenCalledWith(
      '[olas/cross-tab] failed to apply a peer message',
      expect.anything(),
    )
    root.dispose()
  })

  test('a msgId that is not a counter value cannot silence the peer it claims', async () => {
    const { root, probe } = await tab()
    probe.deliver(setData(Number.MAX_VALUE, [], ['forged']))
    probe.deliver(setData(1, [], ['from the real peer']))
    expect(root.api.list.data.value).toEqual(['from the real peer'])
    root.dispose()
  })

  test('validate rejects a payload shape the tab does not expect', async () => {
    const { root, probe, onWarn } = await tab({ validate: (_id, data) => Array.isArray(data) })
    probe.deliver(setData(1, [], 5))
    expect(root.api.list.data.value).toEqual(['a'])
    expect(onWarn).toHaveBeenCalledWith('[olas/cross-tab] setData message rejected by validate')
    probe.deliver(setData(2, [], ['b']))
    expect(root.api.list.data.value).toEqual(['b'])
    root.dispose()
  })
})
