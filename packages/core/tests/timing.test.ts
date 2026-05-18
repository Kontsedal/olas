import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { signal } from '../src/signals'
import { debounced, throttled } from '../src/timing'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('debounced', () => {
  test('starts at the source value', () => {
    const a = signal(10)
    const d = debounced(a, 200)
    expect(d.value).toBe(10)
  })

  test('lags behind by ms after a change', () => {
    const a = signal('a')
    const d = debounced(a, 100)

    a.set('b')
    expect(d.value).toBe('a')

    vi.advanceTimersByTime(99)
    expect(d.value).toBe('a')

    vi.advanceTimersByTime(1)
    expect(d.value).toBe('b')
  })

  test('rapid changes reset the timer; only the final value is emitted', () => {
    const a = signal(0)
    const d = debounced(a, 100)

    a.set(1)
    vi.advanceTimersByTime(50)
    a.set(2)
    vi.advanceTimersByTime(50)
    a.set(3)
    vi.advanceTimersByTime(50)

    // Timer keeps resetting; nothing emitted yet.
    expect(d.value).toBe(0)

    vi.advanceTimersByTime(100)
    expect(d.value).toBe(3)
  })

  test('subscribers fire when the debounced value lands', () => {
    const a = signal('x')
    const d = debounced(a, 50)
    const seen: string[] = []
    const off = d.subscribe((v) => seen.push(v))
    expect(seen).toEqual(['x'])

    a.set('y')
    vi.advanceTimersByTime(50)
    expect(seen).toEqual(['x', 'y'])
    off()
  })
})

describe('throttled', () => {
  test('starts at the source value', () => {
    const a = signal(5)
    const t = throttled(a, 100)
    expect(t.value).toBe(5)
  })

  test('the first change after a quiet window passes through immediately', () => {
    vi.setSystemTime(0)
    const a = signal(0)
    const t = throttled(a, 100)

    vi.setSystemTime(1000)
    a.set(1)
    expect(t.value).toBe(1)
  })

  test('changes within the window are coalesced; latest value emits when window expires', () => {
    vi.setSystemTime(1000)
    const a = signal(0)
    const t = throttled(a, 100)

    a.set(1)
    expect(t.value).toBe(1) // leading

    vi.advanceTimersByTime(50)
    a.set(2)
    vi.advanceTimersByTime(30)
    a.set(3)
    expect(t.value).toBe(1) // still inside the window

    vi.advanceTimersByTime(20)
    expect(t.value).toBe(3) // trailing fires with the latest value
  })

  test('further changes after trailing fire respect the next window', () => {
    vi.setSystemTime(1000)
    const a = signal(0)
    const t = throttled(a, 100)

    a.set(1) // leading at t=1000
    vi.advanceTimersByTime(50)
    a.set(2) // schedules trailing
    vi.advanceTimersByTime(50) // trailing fires at t=1100 with value 2
    expect(t.value).toBe(2)

    // A change immediately after the trailing fire is inside the next window.
    a.set(3)
    expect(t.value).toBe(2)
  })
})
