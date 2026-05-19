import { createRoot, defineController, defineQuery } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import type { ChannelLike } from '../src/channel'
import { crossTabPlugin } from '../src/plugin'

/**
 * Non-cloneable values: cache data carrying functions, class instances,
 * or symbols cannot pass through `BroadcastChannel`'s structured-clone
 * boundary. `postMessage` throws `DataCloneError`. The plugin must:
 * - Catch the throw.
 * - Call `onWarn(...)` with a message mentioning structured cloning.
 * - Leave the sender's cache unaffected.
 * - Skip delivery to receivers (nothing to deliver — the message never
 *   left the sender).
 */

const nonCloneableQuery = defineQuery({
  queryId: 'non-cloneable-test/q',
  crossTab: true,
  key: (id: string) => ['nc', id],
  fetcher: async (_ctx, id: string) => ({ id }),
})

describe('crossTabPlugin non-cloneable data', () => {
  test('functions in payload trigger onWarn and skip delivery', async () => {
    // Use a real-ish channel that mimics structured-clone: postMessage
    // serializes/deserializes the payload and throws on non-clonables.
    const listeners = new Set<(e: { data: unknown }) => void>()
    const factory = (_name: string): ChannelLike => ({
      postMessage(data) {
        // Approximate structured-clone behaviour. JSON serialization
        // doesn't throw on functions (it drops them), so use a stricter
        // check: walk values, throw if any function appears.
        check(data)
        for (const l of listeners) {
          queueMicrotask(() => l({ data }))
        }
      },
      addEventListener(_type, l) {
        listeners.add(l)
      },
      removeEventListener(_type, l) {
        listeners.delete(l)
      },
      close() {},
    })

    function check(value: unknown): void {
      if (typeof value === 'function') throw new Error('DataCloneError: function')
      if (value && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) check(v)
      }
    }

    const onWarnA = vi.fn()
    const def = defineController((ctx) => {
      const q = ctx.use(nonCloneableQuery, () => ['1' as string])
      return { q }
    })
    const a = createRoot(def, {
      deps: {},
      plugins: [
        crossTabPlugin({
          channelName: 'nc-chan',
          channelFactory: factory,
          onWarn: onWarnA,
        }),
      ],
    })

    type Sub = { q: { data: { peek(): { id?: string } | undefined } } }
    // Write a payload that includes a function.
    nonCloneableQuery.setData('1', () => ({ id: '1', cb: () => 'nope' }))
    // Sender cache: the write went through locally (no `postMessage`
    // failure stops the cache write — the plugin runs AFTER setData).
    expect((a as unknown as Sub).q.data.peek()?.id).toBe('1')
    // The warning was raised on the sender.
    expect(onWarnA).toHaveBeenCalled()
    expect(onWarnA.mock.calls[0]![0]).toContain('not structured-cloneable')

    a.dispose()
  })
})
