import { createRoot, defineController, effect, queryEngine } from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createLiveStream,
  type LiveStreamOptions,
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

const mountStream = <T>(options?: LiveStreamOptions<T>) => {
  const realtime = fakeRealtime()
  const def = defineController((ctx) => ({
    stream: createLiveStream<T>(ctx, 'logs', options),
  }))
  const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })
  return { realtime, root, stream: root.api.stream }
}

/** Counts `events` signal writes after the initial read. */
const countWrites = (read: () => unknown) => {
  let runs = 0
  const dispose = effect(() => {
    read()
    runs++
  })
  const baseline = runs
  return { writes: () => runs - baseline, dispose }
}

/** Manual `requestAnimationFrame` queue so frames fire only when the test says so. */
const installManualRaf = (opts: { withCancel: boolean }) => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 1
  const raf = vi.fn((cb: FrameRequestCallback) => {
    const id = nextId++
    frames.set(id, cb)
    return id
  })
  const caf = vi.fn((id: number) => {
    frames.delete(id)
  })
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', opts.withCancel ? caf : undefined)
  return {
    raf,
    caf,
    pendingFrames: () => frames.size,
    runFrames: () => {
      const cbs = [...frames.values()]
      frames.clear()
      for (const cb of cbs) cb(0)
    },
  }
}

describe('createLiveStream — options validation and defaults', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test.each([0, -5])('capacity %i throws a RangeError before subscribing', (capacity) => {
    const realtime = fakeRealtime()
    const def = defineController((ctx) => ({
      stream: createLiveStream<string>(ctx, 'logs', { capacity }),
    }))
    expect(() => createRoot(def, { queries: queryEngine(), deps: { realtime } })).toThrow(
      new RangeError(`[olas/realtime] createLiveStream: capacity must be >= 1, got ${capacity}`),
    )
    expect(realtime.subscriberCount('logs')).toBe(0)
  })

  test('capacity 1 is accepted and keeps only the newest event', () => {
    const { realtime, root, stream } = mountStream<string>({ capacity: 1, flushMs: 0 })
    realtime.emit('logs', 'a')
    realtime.emit('logs', 'b')
    expect(stream.events.value).toEqual(['b'])
    root.dispose()
  })

  test('with no options: flushes after the 16 ms default and caps at 1000 events', () => {
    const { realtime, root, stream } = mountStream<number>()
    expect(stream.isPaused.value).toBe(false)

    for (let i = 0; i < 1005; i++) realtime.emit('logs', i)
    vi.advanceTimersByTime(15)
    expect(stream.events.value).toEqual([])

    vi.advanceTimersByTime(1)
    expect(stream.events.value.length).toBe(1000)
    expect(stream.events.value[0]).toBe(5)
    expect(stream.events.value[999]).toBe(1004)
    root.dispose()
  })

  test('negative flushMs flushes synchronously per event', () => {
    const { realtime, root, stream } = mountStream<string>({ flushMs: -1 })
    const counter = countWrites(() => stream.events.value)
    realtime.emit('logs', 'a')
    expect(stream.events.value).toEqual(['a'])
    realtime.emit('logs', 'b')
    expect(stream.events.value).toEqual(['a', 'b'])
    expect(counter.writes()).toBe(2)
    counter.dispose()
    root.dispose()
  })
})

describe('createLiveStream — onDrop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('receives the dropped slice oldest-first, only when the cap is exceeded', () => {
    const onDrop = vi.fn<(dropped: readonly string[]) => void>()
    const { realtime, root, stream } = mountStream<string>({ capacity: 3, flushMs: 10, onDrop })

    realtime.emit('logs', 'a')
    realtime.emit('logs', 'b')
    vi.advanceTimersByTime(10)
    expect(stream.events.value).toEqual(['a', 'b'])
    expect(onDrop).not.toHaveBeenCalled()

    // One flush merges buffered ['a','b'] with pending ['c','d','e'].
    for (const ev of ['c', 'd', 'e']) realtime.emit('logs', ev)
    vi.advanceTimersByTime(10)
    expect(stream.events.value).toEqual(['c', 'd', 'e'])
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledWith(['a', 'b'])
    root.dispose()
  })

  test('a throwing onDrop does not break the stream', () => {
    const onDrop = vi.fn(() => {
      throw new Error('drop handler exploded')
    })
    const { realtime, root, stream } = mountStream<number>({ capacity: 2, flushMs: 0, onDrop })

    for (let i = 1; i <= 4; i++) realtime.emit('logs', i)
    expect(stream.events.value).toEqual([3, 4])
    expect(onDrop).toHaveBeenCalledTimes(2)
    expect(onDrop).toHaveBeenNthCalledWith(1, [1])
    expect(onDrop).toHaveBeenNthCalledWith(2, [2])

    // Still subscribed and still flushing.
    expect(realtime.subscriberCount('logs')).toBe(1)
    realtime.emit('logs', 5)
    expect(stream.events.value).toEqual([4, 5])
    root.dispose()
  })
})

describe('createLiveStream — clear() on the timer path', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('discards unflushed pending events and cancels the scheduled flush', () => {
    const { realtime, root, stream } = mountStream<string>({ capacity: 10, flushMs: 20 })
    realtime.emit('logs', 'a')
    vi.advanceTimersByTime(20)
    expect(stream.events.value).toEqual(['a'])

    realtime.emit('logs', 'b')
    realtime.emit('logs', 'c')
    stream.clear()
    expect(stream.events.value).toEqual([])

    // The cancelled flush must not resurrect 'b' / 'c'.
    vi.advanceTimersByTime(100)
    expect(stream.events.value).toEqual([])

    // A new event after clear() schedules a fresh flush.
    realtime.emit('logs', 'd')
    vi.advanceTimersByTime(20)
    expect(stream.events.value).toEqual(['d'])
    root.dispose()
  })
})

describe('createLiveStream — rafFlush with requestAnimationFrame', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('coalesces a burst into one frame and ignores flushMs', () => {
    const frame = installManualRaf({ withCancel: true })
    // flushMs: 0 would mean synchronous flush — rafFlush overrides it.
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true, flushMs: 0 })
    const counter = countWrites(() => stream.events.value)

    realtime.emit('logs', 'a')
    realtime.emit('logs', 'b')
    realtime.emit('logs', 'c')
    expect(stream.events.value).toEqual([])
    expect(frame.raf).toHaveBeenCalledTimes(1)

    frame.runFrames()
    expect(stream.events.value).toEqual(['a', 'b', 'c'])
    expect(counter.writes()).toBe(1)

    // The frame handle was released, so the next event requests a new frame.
    realtime.emit('logs', 'd')
    expect(frame.raf).toHaveBeenCalledTimes(2)
    frame.runFrames()
    expect(stream.events.value).toEqual(['a', 'b', 'c', 'd'])
    expect(counter.writes()).toBe(2)

    counter.dispose()
    root.dispose()
  })

  test('pause() cancels the pending frame; the events flush on a new frame after resume()', () => {
    const frame = installManualRaf({ withCancel: true })
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true })

    realtime.emit('logs', 'queued')
    expect(frame.pendingFrames()).toBe(1)

    stream.pause()
    expect(frame.caf).toHaveBeenCalledTimes(1)
    expect(frame.pendingFrames()).toBe(0)
    expect(realtime.subscriberCount('logs')).toBe(0)
    expect(stream.events.value).toEqual([])

    stream.resume()
    expect(realtime.subscriberCount('logs')).toBe(1)
    expect(frame.pendingFrames()).toBe(1)
    frame.runFrames()
    expect(stream.events.value).toEqual(['queued'])
    root.dispose()
  })

  test('clear() cancels the pending frame and drops the pending events', () => {
    const frame = installManualRaf({ withCancel: true })
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true })

    realtime.emit('logs', 'a')
    stream.clear()
    expect(frame.caf).toHaveBeenCalledTimes(1)
    expect(frame.pendingFrames()).toBe(0)
    expect(stream.events.value).toEqual([])

    // Subscription survives clear(); new events request a fresh frame.
    realtime.emit('logs', 'b')
    expect(frame.raf).toHaveBeenCalledTimes(2)
    frame.runFrames()
    expect(stream.events.value).toEqual(['b'])
    root.dispose()
  })

  test('dispose cancels the pending frame and unsubscribes', () => {
    const frame = installManualRaf({ withCancel: true })
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true })

    realtime.emit('logs', 'a')
    root.dispose()
    expect(frame.caf).toHaveBeenCalledTimes(1)
    expect(frame.pendingFrames()).toBe(0)
    expect(realtime.subscriberCount('logs')).toBe(0)
    expect(stream.events.value).toEqual([])
  })

  test('without cancelAnimationFrame, a frame that fires after clear() writes nothing', () => {
    const frame = installManualRaf({ withCancel: false })
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true })
    const counter = countWrites(() => stream.events.value)

    realtime.emit('logs', 'a')
    stream.clear()
    expect(counter.writes()).toBe(1) // clear() itself writes []
    // The frame could not be cancelled; it still fires, but finds nothing pending.
    expect(frame.pendingFrames()).toBe(1)
    frame.runFrames()
    expect(stream.events.value).toEqual([])
    expect(counter.writes()).toBe(1)

    counter.dispose()
    root.dispose()
  })
})

describe('createLiveStream — rafFlush without requestAnimationFrame (Node)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('falls back to setTimeout(0) and still lands a same-tick burst as one write', () => {
    expect(typeof requestAnimationFrame).toBe('undefined')
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true, flushMs: 500 })
    const counter = countWrites(() => stream.events.value)

    realtime.emit('logs', 'a')
    realtime.emit('logs', 'b')
    expect(stream.events.value).toEqual([])

    // flushMs is ignored: the fallback fires on the next 0 ms tick.
    vi.advanceTimersByTime(0)
    expect(stream.events.value).toEqual(['a', 'b'])
    expect(counter.writes()).toBe(1)

    counter.dispose()
    root.dispose()
  })
})

describe('createLiveStream — rafFlush without requestAnimationFrame', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('events in one tick share one fallback timer, and dispose cancels it', async () => {
    // Node has no requestAnimationFrame, so rafFlush degrades to setTimeout(0).
    expect(typeof requestAnimationFrame).toBe('undefined')
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true })
    realtime.emit('logs', 'a')
    realtime.emit('logs', 'b')
    expect(vi.getTimerCount()).toBe(1)
    root.dispose()
    await vi.advanceTimersByTimeAsync(10)
    expect(stream.events.value).toEqual([])
  })

  test('the shared timer flushes every event of the tick together', async () => {
    const { realtime, root, stream } = mountStream<string>({ rafFlush: true })
    realtime.emit('logs', 'a')
    realtime.emit('logs', 'b')
    await vi.advanceTimersByTimeAsync(0)
    expect(stream.events.value).toEqual(['a', 'b'])
    root.dispose()
  })
})
