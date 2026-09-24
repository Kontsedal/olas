// `channel` as a signal: the patcher and the live stream follow the name.
import { computed, createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import { createLiveStream, createRealtimePatcher } from '../src'
import { fakeRealtime } from './fake-realtime'

type RoomEvent = { type: 'message'; text: string }

describe('createRealtimePatcher with a channel signal', () => {
  test('a new name moves the subscription to the new channel', () => {
    const realtime = fakeRealtime()
    const roomId = signal('a')
    const seen: string[] = []
    const def = defineController((ctx) => {
      createRealtimePatcher<RoomEvent>(
        ctx,
        computed(() => `room:${roomId.value}`),
        { message: (ev) => seen.push(ev.text) },
      )
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })
    expect(realtime.subscriberCount('room:a')).toBe(1)
    realtime.emit('room:a', { type: 'message', text: 'a1' })

    roomId.set('b')
    expect(realtime.subscriberCount('room:a')).toBe(0)
    expect(realtime.subscriberCount('room:b')).toBe(1)
    realtime.emit('room:a', { type: 'message', text: 'a2' })
    realtime.emit('room:b', { type: 'message', text: 'b1' })
    expect(seen).toEqual(['a1', 'b1'])

    root.dispose()
    expect(realtime.subscriberCount('room:b')).toBe(0)
  })

  test('a write of the same name does not resubscribe', () => {
    const realtime = fakeRealtime()
    const channel = signal('feed')
    const def = defineController((ctx) => {
      createRealtimePatcher<RoomEvent>(ctx, channel, {})
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })
    channel.set('feed')
    expect(realtime.subscribed).toEqual(['feed'])
    root.dispose()
  })

  test('a signal read inside a handler does not become a channel dependency', () => {
    const realtime = fakeRealtime()
    const channel = signal('feed')
    const other = signal(0)
    const def = defineController((ctx) => {
      createRealtimePatcher<RoomEvent>(ctx, channel, { message: () => void other.value })
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })
    realtime.emit('feed', { type: 'message', text: 'x' })
    other.set(1)
    expect(realtime.subscribed).toEqual(['feed'])
    root.dispose()
  })
})

describe('createLiveStream with a channel signal', () => {
  const build = (flushMs = 0) => {
    const realtime = fakeRealtime()
    const channel = signal('logs:a')
    const def = defineController((ctx) => ({
      stream: createLiveStream<string>(ctx, channel, { flushMs }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })
    return { realtime, channel, root, stream: root.api.stream }
  }

  test('a new name moves the subscription and empties the buffer', () => {
    const { realtime, channel, root, stream } = build()
    realtime.emit('logs:a', 'a1')
    expect(stream.events.value).toEqual(['a1'])

    channel.set('logs:b')
    expect(stream.events.value).toEqual([])
    expect(realtime.subscriberCount('logs:a')).toBe(0)
    expect(realtime.subscriberCount('logs:b')).toBe(1)

    realtime.emit('logs:a', 'a2')
    realtime.emit('logs:b', 'b1')
    expect(stream.events.value).toEqual(['b1'])
    root.dispose()
  })

  test('events waiting for a flush from the old channel are dropped too', () => {
    vi.useFakeTimers()
    try {
      const { realtime, channel, root, stream } = build(16)
      realtime.emit('logs:a', 'a1')
      channel.set('logs:b')
      realtime.emit('logs:b', 'b1')
      vi.advanceTimersByTime(16)
      expect(stream.events.value).toEqual(['b1'])
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a change during a pause empties the buffer; resume subscribes to the new name', () => {
    const { realtime, channel, root, stream } = build()
    realtime.emit('logs:a', 'a1')
    stream.pause()
    expect(realtime.subscriberCount('logs:a')).toBe(0)

    channel.set('logs:b')
    expect(stream.events.value).toEqual([])
    expect(realtime.subscriberCount('logs:b')).toBe(0)

    stream.resume()
    expect(realtime.subscribed).toEqual(['logs:a', 'logs:b'])
    realtime.emit('logs:b', 'b1')
    expect(stream.events.value).toEqual(['b1'])
    root.dispose()
  })

  test('pause and resume on one channel keep the buffer', () => {
    const { realtime, root, stream } = build()
    realtime.emit('logs:a', 'a1')
    stream.pause()
    stream.resume()
    expect(stream.events.value).toEqual(['a1'])
    expect(realtime.subscribed).toEqual(['logs:a', 'logs:a'])
    root.dispose()
  })
})
