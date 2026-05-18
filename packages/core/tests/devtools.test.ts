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

  test('subscribed handlers receive events', () => {
    const bus = new DevtoolsEmitter()
    const handler = vi.fn<(e: DebugEvent) => void>()
    bus.subscribe(handler)
    const event: DebugEvent = {
      type: 'controller:constructed',
      path: ['root'],
      props: { id: 1 },
    }
    bus.emit(event)
    expect(handler).toHaveBeenCalledWith(event)
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
