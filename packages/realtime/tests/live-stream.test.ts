import { createRoot, defineController, effect } from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  defineLiveStream,
  type RealtimeHandler,
  type RealtimeService,
  type RealtimeSubscription,
} from '../src'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}

type Listener = { handler: RealtimeHandler<unknown> }

const fakeRealtime = () => {
  const channels = new Map<string, Set<Listener>>()
  const service: RealtimeService & {
    emit: (channel: string, event: unknown) => void
    subscriberCount: (channel: string) => number
  } = {
    subscribe<TEvent = unknown>(
      channel: string,
      handler: RealtimeHandler<TEvent>,
    ): RealtimeSubscription {
      let set = channels.get(channel)
      if (!set) {
        set = new Set()
        channels.set(channel, set)
      }
      const entry: Listener = { handler: handler as RealtimeHandler<unknown> }
      set.add(entry)
      return {
        unsubscribe() {
          set?.delete(entry)
        },
      }
    },
    emit(channel, event) {
      const set = channels.get(channel)
      if (!set) return
      for (const l of set) l.handler(event)
    },
    subscriberCount(channel) {
      return channels.get(channel)?.size ?? 0
    },
  }
  return service
}

describe('defineLiveStream', () => {
  test('buffer caps at capacity, oldest events drop (flushMs=0)', () => {
    const realtime = fakeRealtime()
    const def = defineController((ctx) => {
      const stream = defineLiveStream<string>(ctx, 'logs', {
        capacity: 3,
        flushMs: 0,
      })
      return { stream }
    })
    const root = createRoot(def, { deps: { realtime } })

    for (const ch of ['a', 'b', 'c', 'd', 'e']) {
      realtime.emit('logs', ch)
    }

    expect(root.stream.events.value).toEqual(['c', 'd', 'e'])
    expect(root.stream.events.value.length).toBe(3)

    root.dispose()
  })

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    test('flushMs coalesces N emissions into one signal write', () => {
      const realtime = fakeRealtime()
      const def = defineController((ctx) => {
        const stream = defineLiveStream<number>(ctx, 'logs', {
          capacity: 100,
          flushMs: 16,
        })
        return { stream }
      })
      const root = createRoot(def, { deps: { realtime } })

      // Count writes to events$ via an effect that observes the value.
      let writes = 0
      const dispose = effect(() => {
        // Tracked read.
        void root.stream.events.value
        writes++
      })
      // The initial run counts as one write — reset so we count only flushes.
      const baseline = writes

      for (let i = 0; i < 10; i++) realtime.emit('logs', i)
      // Pending events not yet flushed.
      expect(writes - baseline).toBe(0)

      vi.advanceTimersByTime(16)
      expect(writes - baseline).toBe(1)
      expect(root.stream.events.value).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

      dispose()
      root.dispose()
    })

    test('pause stops buffering; resume continues; buffer survives the pause', () => {
      const realtime = fakeRealtime()
      const def = defineController((ctx) => {
        const stream = defineLiveStream<string>(ctx, 'logs', {
          capacity: 100,
          flushMs: 16,
        })
        return { stream }
      })
      const root = createRoot(def, { deps: { realtime } })

      realtime.emit('logs', 'a')
      vi.advanceTimersByTime(16)
      expect(root.stream.events.value).toEqual(['a'])

      root.stream.pause()
      expect(root.stream.isPaused.value).toBe(true)
      // Subscription should be gone — emit lands nowhere.
      realtime.emit('logs', 'b')
      vi.advanceTimersByTime(16)
      expect(root.stream.events.value).toEqual(['a'])

      root.stream.resume()
      expect(root.stream.isPaused.value).toBe(false)
      realtime.emit('logs', 'c')
      vi.advanceTimersByTime(16)
      expect(root.stream.events.value).toEqual(['a', 'c'])

      root.dispose()
    })

    test('dispose clears the pending flush timer and unsubscribes', () => {
      const realtime = fakeRealtime()
      const def = defineController((ctx) => {
        const stream = defineLiveStream<string>(ctx, 'logs', {
          capacity: 100,
          flushMs: 100,
        })
        return { stream }
      })
      const root = createRoot(def, { deps: { realtime } })

      realtime.emit('logs', 'a')
      // Pending flush scheduled but not yet fired.
      expect(root.stream.events.value).toEqual([])

      // Snapshot the events read BEFORE dispose so we can compare after.
      const before = root.stream.events.value

      root.dispose()
      // Subscriber gone.
      expect(realtime.subscriberCount('logs')).toBe(0)

      // Advance past the original flush deadline — no late write should land.
      vi.advanceTimersByTime(200)
      expect(root.stream.events.value).toBe(before)
      expect(root.stream.events.value).toEqual([])
    })

    test('clear() empties without killing the subscription', () => {
      const realtime = fakeRealtime()
      const def = defineController((ctx) => {
        const stream = defineLiveStream<string>(ctx, 'logs', {
          capacity: 100,
          flushMs: 16,
        })
        return { stream }
      })
      const root = createRoot(def, { deps: { realtime } })

      realtime.emit('logs', 'a')
      vi.advanceTimersByTime(16)
      expect(root.stream.events.value).toEqual(['a'])

      root.stream.clear()
      expect(root.stream.events.value).toEqual([])
      // Subscription preserved.
      expect(realtime.subscriberCount('logs')).toBe(1)

      realtime.emit('logs', 'b')
      vi.advanceTimersByTime(16)
      expect(root.stream.events.value).toEqual(['b'])

      root.dispose()
    })
  })
})
