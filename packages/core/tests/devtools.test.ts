import { describe, expect, test, vi } from 'vitest'
import { type DebugEvent, DevtoolsEmitter } from '../src/devtools'

describe('DevtoolsEmitter', () => {
  test('emit is a no-op when no one is subscribed', () => {
    const bus = new DevtoolsEmitter()
    expect(bus.hasSubscribers).toBe(false)
    expect(() => {
      bus.emit({ type: 'cache:gc', queryKey: ['x'] })
    }).not.toThrow()
  })

  test('subscribed handlers receive events (with seq/t stamped on)', () => {
    const bus = new DevtoolsEmitter()
    const handler = vi.fn<(e: DebugEvent) => void>()
    bus.subscribe(handler)
    bus.emit({ type: 'controller:constructed', path: ['root'], props: { id: 1 } })
    expect(handler).toHaveBeenCalledTimes(1)
    const received = handler.mock.calls[0]![0]
    // The emitter delivers a stamped copy: original fields preserved, `seq`/`t`
    // added by the bus.
    expect(received).toMatchObject({
      type: 'controller:constructed',
      path: ['root'],
      props: { id: 1 },
    })
    expect(typeof received.seq).toBe('number')
    expect(typeof received.t).toBe('number')
  })

  test('emit stamps a strictly-increasing seq and a timestamp', () => {
    const bus = new DevtoolsEmitter()
    const events: DebugEvent[] = []
    bus.subscribe((e) => events.push(e))
    bus.emit({ type: 'cache:gc', queryKey: ['a'] })
    bus.emit({ type: 'cache:gc', queryKey: ['b'] })
    expect(events.map((e) => e.seq)).toEqual([1, 2])
    expect(typeof events[0]!.t).toBe('number')
  })

  test('emit preserves a caller-supplied causeId while stamping seq/t', () => {
    const bus = new DevtoolsEmitter()
    const events: DebugEvent[] = []
    bus.subscribe((e) => events.push(e))
    bus.emit({
      type: 'cache:set-data',
      queryKey: ['x'],
      source: 'fetch',
      data: 1,
      causeId: 'fetch:9',
    })
    expect(events[0]).toMatchObject({ type: 'cache:set-data', source: 'fetch', causeId: 'fetch:9' })
    expect(typeof events[0]!.seq).toBe('number')
  })

  test('replayed snapshot events to a late subscriber are stamped too', () => {
    const bus = new DevtoolsEmitter()
    bus.emit({ type: 'controller:constructed', path: ['root'], props: undefined })
    const events: DebugEvent[] = []
    bus.subscribe((e) => events.push(e))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('controller:constructed')
    expect(typeof events[0]!.seq).toBe('number')
    expect(typeof events[0]!.t).toBe('number')
  })

  test('subscribe returns an unsubscribe function', () => {
    const bus = new DevtoolsEmitter()
    const handler = vi.fn()
    const off = bus.subscribe(handler)
    bus.emit({ type: 'cache:gc', queryKey: ['x'] })
    off()
    bus.emit({ type: 'cache:gc', queryKey: ['x'] })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('a throwing handler does not break delivery to other handlers', () => {
    const bus = new DevtoolsEmitter()
    const h1 = vi.fn(() => {
      throw new Error('bad')
    })
    const h2 = vi.fn()
    bus.subscribe(h1)
    bus.subscribe(h2)
    bus.emit({ type: 'cache:gc', queryKey: ['x'] })
    expect(h2).toHaveBeenCalled()
  })

  test('hasSubscribers reflects current state', () => {
    const bus = new DevtoolsEmitter()
    expect(bus.hasSubscribers).toBe(false)
    const off = bus.subscribe(() => {})
    expect(bus.hasSubscribers).toBe(true)
    off()
    expect(bus.hasSubscribers).toBe(false)
  })
})
