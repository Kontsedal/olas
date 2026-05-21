import { describe, expect, test, vi } from 'vitest'
import { batch, computed, effect, signal, untracked } from '../src/signals'
import { readOnly } from '../src/signals/readonly'

describe('signal', () => {
  test('holds an initial value', () => {
    const s = signal(0)
    expect(s.value).toBe(0)
  })

  test('writing via .value updates the value', () => {
    const s = signal(0)
    s.value = 5
    expect(s.value).toBe(5)
  })

  test('.set writes the value', () => {
    const s = signal('a')
    s.set('b')
    expect(s.value).toBe('b')
  })

  test('.update transforms via a function', () => {
    const s = signal(10)
    s.update((prev) => prev + 1)
    s.update((prev) => prev * 2)
    expect(s.value).toBe(22)
  })

  test('.peek returns the current value', () => {
    const s = signal(42)
    expect(s.peek()).toBe(42)
    s.set(7)
    expect(s.peek()).toBe(7)
  })
})

describe('computed', () => {
  test('derives from a signal', () => {
    const a = signal(2)
    const b = computed(() => a.value * 3)
    expect(b.value).toBe(6)
    a.set(5)
    expect(b.value).toBe(15)
  })

  test('memoizes when dependencies have not changed', () => {
    const a = signal(1)
    const fn = vi.fn(() => a.value + 1)
    const c = computed(fn)

    expect(c.value).toBe(2)
    expect(c.value).toBe(2)
    expect(c.value).toBe(2)
    expect(fn).toHaveBeenCalledTimes(1)

    a.set(2)
    expect(c.value).toBe(3)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('chains', () => {
    const a = signal(1)
    const b = computed(() => a.value + 1)
    const c = computed(() => b.value + 1)
    expect(c.value).toBe(3)
    a.set(10)
    expect(c.value).toBe(12)
  })
})

describe('effect', () => {
  test('runs once immediately', () => {
    const fn = vi.fn()
    const dispose = effect(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    dispose()
  })

  test('re-runs when a tracked signal changes', () => {
    const a = signal(1)
    const observed: number[] = []
    const dispose = effect(() => {
      observed.push(a.value)
    })

    a.set(2)
    a.set(3)
    expect(observed).toEqual([1, 2, 3])
    dispose()
  })

  test('dispose stops re-runs', () => {
    const a = signal(0)
    const fn = vi.fn(() => {
      void a.value
    })
    const dispose = effect(fn)
    expect(fn).toHaveBeenCalledTimes(1)

    dispose()
    a.set(1)
    a.set(2)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('cleanup function runs before the next run and on dispose', () => {
    const a = signal(0)
    const cleanups: number[] = []
    const dispose = effect(() => {
      const captured = a.value
      return () => {
        cleanups.push(captured)
      }
    })

    a.set(1)
    expect(cleanups).toEqual([0])
    a.set(2)
    expect(cleanups).toEqual([0, 1])
    dispose()
    expect(cleanups).toEqual([0, 1, 2])
  })
})

describe('batch', () => {
  test('coalesces multiple writes into one effect run', () => {
    const a = signal(0)
    const b = signal(0)
    const fn = vi.fn(() => {
      void a.value
      void b.value
    })
    const dispose = effect(fn)
    expect(fn).toHaveBeenCalledTimes(1)

    batch(() => {
      a.set(1)
      b.set(1)
      a.set(2)
    })
    expect(fn).toHaveBeenCalledTimes(2)
    dispose()
  })

  test('returns the inner value', () => {
    const result = batch(() => 'hello')
    expect(result).toBe('hello')
  })
})

describe('peek vs value (tracking)', () => {
  test('reads inside effect via .value track dependencies', () => {
    const a = signal(1)
    const fn = vi.fn(() => {
      void a.value
    })
    const dispose = effect(fn)
    a.set(2)
    expect(fn).toHaveBeenCalledTimes(2)
    dispose()
  })

  test('reads inside effect via .peek do NOT track', () => {
    const a = signal(1)
    const fn = vi.fn(() => {
      void a.peek()
    })
    const dispose = effect(fn)
    a.set(2)
    a.set(3)
    expect(fn).toHaveBeenCalledTimes(1)
    dispose()
  })

  test('untracked() suppresses tracking for nested reads', () => {
    const a = signal(1)
    const b = signal(10)
    const fn = vi.fn(() => {
      void a.value
      untracked(() => {
        void b.value
      })
    })
    const dispose = effect(fn)

    b.set(20)
    expect(fn).toHaveBeenCalledTimes(1) // b not tracked

    a.set(2)
    expect(fn).toHaveBeenCalledTimes(2) // a tracked
    dispose()
  })
})

describe('subscribe / unsubscribe', () => {
  test('subscribe fires immediately with current value and on changes', () => {
    const a = signal('a')
    const seen: string[] = []
    const unsub = a.subscribe((v) => {
      seen.push(v)
    })

    a.set('b')
    a.set('c')
    expect(seen).toEqual(['a', 'b', 'c'])
    unsub()
  })

  test('unsubscribe stops notifications', () => {
    const a = signal(0)
    const handler = vi.fn()
    const unsub = a.subscribe(handler)
    expect(handler).toHaveBeenCalledTimes(1) // initial

    a.set(1)
    expect(handler).toHaveBeenCalledTimes(2)

    unsub()
    a.set(2)
    a.set(3)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  test('multiple subscribers each see updates independently', () => {
    const a = signal(0)
    const h1 = vi.fn()
    const h2 = vi.fn()
    const u1 = a.subscribe(h1)
    const u2 = a.subscribe(h2)

    a.set(1)
    expect(h1).toHaveBeenLastCalledWith(1)
    expect(h2).toHaveBeenLastCalledWith(1)

    u1()
    a.set(2)
    expect(h1).toHaveBeenCalledTimes(2)
    expect(h2).toHaveBeenLastCalledWith(2)

    u2()
  })
})

describe('glitch-free updates (diamond dependency)', () => {
  test('computed in a diamond observes consistent state', () => {
    const a = signal(1)
    const b = computed(() => a.value * 2)
    const c = computed(() => a.value * 3)
    const d = computed(() => b.value + c.value)

    expect(d.value).toBe(5)
    a.set(2)
    expect(d.value).toBe(10)
  })

  test('effect in a diamond runs once per logical change', () => {
    const a = signal(1)
    const b = computed(() => a.value + 1)
    const c = computed(() => a.value + 2)

    const fn = vi.fn(() => {
      void b.value
      void c.value
    })
    const dispose = effect(fn)
    expect(fn).toHaveBeenCalledTimes(1)

    a.set(5)
    expect(fn).toHaveBeenCalledTimes(2) // not 3
    dispose()
  })
})

describe('readOnly', () => {
  test('exposes value/peek/subscribe', () => {
    const s = signal(10)
    const ro = readOnly(s)
    expect(ro.value).toBe(10)
    expect(ro.peek()).toBe(10)
    s.set(20)
    expect(ro.value).toBe(20)
  })

  test('does not expose set/update at runtime', () => {
    const s = signal(0)
    const ro = readOnly(s)
    // ro should not carry the writer surface
    expect((ro as unknown as { set?: unknown }).set).toBeUndefined()
    expect((ro as unknown as { update?: unknown }).update).toBeUndefined()
  })

  test('subscribers see updates from the underlying signal', () => {
    const s = signal('a')
    const ro = readOnly(s)
    const seen: string[] = []
    const unsub = ro.subscribe((v) => seen.push(v))
    s.set('b')
    expect(seen).toEqual(['a', 'b'])
    unsub()
  })

  test('the returned object is frozen — no runtime mutation', () => {
    const s = signal(1)
    const ro = readOnly(s)
    expect(Object.isFrozen(ro)).toBe(true)
    // In strict mode (ESM modules use strict mode), assigning to a frozen
    // object's property throws TypeError. In sloppy mode it would silently
    // no-op — either way, the underlying signal is unchanged.
    expect(() => {
      ;(ro as unknown as { value: number }).value = 99
    }).toThrow(TypeError)
    expect(s.peek()).toBe(1)
    expect(ro.value).toBe(1)
  })
})
