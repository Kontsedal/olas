import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSelection, debounced, signal, throttled } from '../src'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('debounced.flush', () => {
  test('emits a pending value at once; with nothing pending it changes nothing', () => {
    const source = signal(0)
    const d = debounced(source, 100)
    const seen: number[] = []
    d.subscribeChanges((v) => seen.push(v))

    d.flush()
    expect(seen).toEqual([])

    source.set(1)
    expect(d.value).toBe(0)
    d.flush()
    expect(d.value).toBe(1)
    // The trailing timer was cleared, so nothing fires later.
    vi.advanceTimersByTime(500)
    expect(seen).toEqual([1])
    d.dispose()
  })
})

describe('throttled.flush and lifecycle', () => {
  test('flush emits the coalesced trailing value now and cancels its timer', () => {
    const source = signal(0)
    const t = throttled(source, 100)
    const seen: number[] = []
    t.subscribeChanges((v) => seen.push(v))
    source.set(1) // leading edge
    source.set(2) // coalesced into the trailing edge
    expect(seen).toEqual([1])
    t.flush()
    expect(seen).toEqual([1, 2])
    vi.advanceTimersByTime(500)
    expect(seen).toEqual([1, 2])
    t.dispose()
  })

  test('an already-aborted signal disposes at once: source writes never arrive', () => {
    const controller = new AbortController()
    controller.abort()
    const source = signal(0)
    const t = throttled(source, 100, { signal: controller.signal })
    source.set(5)
    vi.advanceTimersByTime(500)
    expect(t.value).toBe(0)
  })
})

describe('selection shift-click over a Map index', () => {
  const rows = ['a', 'b', 'c', 'd', 'e']
  const index: ReadonlyMap<string, number> = new Map(rows.map((id, i) => [id, i]))
  const selected = (s: ReturnType<typeof createSelection>) => [...s.selectedIds.value].sort()

  test('extends a range forward and backward from the anchor, against the pre-shift selection', () => {
    const s = createSelection()
    s.handleClick('b', {}, index)
    s.handleClick('d', { shift: true }, index)
    expect(selected(s)).toEqual(['b', 'c', 'd'])
    // Target before the anchor: the range shrinks and flips direction.
    s.handleClick('a', { shift: true }, index)
    expect(selected(s)).toEqual(['a', 'b'])
    expect(s.size.value).toBe(2)
  })

  test('an id missing from the index selects only the clicked id', () => {
    const s = createSelection()
    s.handleClick('b', {}, index)
    // Target not in the index.
    s.handleClick('zz', { shift: true }, index)
    expect(selected(s)).toEqual(['zz'])
    // The anchor ('zz') is now not in the index either.
    s.handleClick('c', { shift: true }, index)
    expect(selected(s)).toEqual(['c'])
  })

  test('selectedIds.subscribeChanges fires on changes only', () => {
    const s = createSelection({ initial: ['a'] })
    const seen: string[][] = []
    const off = s.selectedIds.subscribeChanges((ids) => seen.push([...ids].sort()))
    s.select('b')
    off()
    s.select('c')
    expect(seen).toEqual([['a', 'b']])
  })
})
