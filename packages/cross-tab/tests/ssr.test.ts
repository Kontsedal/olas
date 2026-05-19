import { createRoot, defineController } from '@olas/core'
import { describe, expect, test, vi } from 'vitest'
import { crossTabPlugin } from '../src/plugin'

/**
 * SSR-safety contract: when no `BroadcastChannel` is reachable (Node
 * without --experimental-broadcastchannel, older browsers), the plugin
 * must return a no-op without throwing. The root still constructs; cross-
 * tab sync is just disabled.
 *
 * We simulate the absence by passing `channelFactory: () => undefined` —
 * same code path as the default factory hitting `typeof BroadcastChannel
 * === 'undefined'`.
 */

describe('crossTabPlugin SSR', () => {
  test('returns a no-op plugin when channelFactory returns undefined', () => {
    const def = defineController(() => ({}))
    expect(() =>
      createRoot(def, {
        deps: {},
        plugins: [crossTabPlugin({ channelName: 'unused', channelFactory: () => undefined })],
      }).dispose(),
    ).not.toThrow()
  })

  test('no-op plugin does not log onWarn during normal operation', () => {
    const onWarn = vi.fn()
    const def = defineController(() => ({}))
    const root = createRoot(def, {
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
