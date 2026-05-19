import { describe, expect, test, vi } from 'vitest'
import { selection } from '../src/selection'

describe('selection — basics', () => {
  test('starts empty by default', () => {
    const s = selection<string>()
    expect(s.selectedIds.value.size).toBe(0)
    expect(s.size.value).toBe(0)
  })

  test('honors initial selection', () => {
    const s = selection<string>({ initial: ['a', 'b'] })
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b'])
    expect(s.size.value).toBe(2)
  })

  test('isSelected tracks the membership of a given id', () => {
    const s = selection<string>()
    const observed: boolean[] = []
    const stop = s.isSelected('x').subscribe((v) => observed.push(v))
    expect(observed).toEqual([false])
    s.select('x')
    expect(observed).toEqual([false, true])
    s.deselect('x')
    expect(observed).toEqual([false, true, false])
    stop()
  })

  test('size is reactive', () => {
    const s = selection<string>()
    const observed: number[] = []
    const stop = s.size.subscribe((n) => observed.push(n))
    s.select('a')
    s.select('b')
    s.deselect('a')
    expect(observed).toEqual([0, 1, 2, 1])
    stop()
  })
})

describe('selection — imperative', () => {
  test('select adds and is idempotent', () => {
    const s = selection<string>()
    s.select('a')
    s.select('a')
    expect([...s.selectedIds.value]).toEqual(['a'])
  })

  test('deselect removes and is a no-op when absent', () => {
    const s = selection<string>({ initial: ['a'] })
    s.deselect('missing')
    expect([...s.selectedIds.value]).toEqual(['a'])
    s.deselect('a')
    expect([...s.selectedIds.value]).toEqual([])
  })

  test('toggle adds then removes', () => {
    const s = selection<string>()
    s.toggle('a')
    expect(s.selectedIds.value.has('a')).toBe(true)
    s.toggle('a')
    expect(s.selectedIds.value.has('a')).toBe(false)
  })

  test('clear empties the set', () => {
    const s = selection<string>({ initial: ['a', 'b', 'c'] })
    s.clear()
    expect(s.selectedIds.value.size).toBe(0)
  })

  test('clear is a no-op when already empty (no signal write)', () => {
    const s = selection<string>()
    const fn = vi.fn()
    const stop = s.selectedIds.subscribe(fn)
    fn.mockClear()
    s.clear()
    expect(fn).not.toHaveBeenCalled()
    stop()
  })

  test('selectAll replaces the set', () => {
    const s = selection<string>({ initial: ['x'] })
    s.selectAll(['a', 'b'])
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b'])
  })

  test('selectAll with empty list clears', () => {
    const s = selection<string>({ initial: ['a'] })
    s.selectAll([])
    expect(s.selectedIds.value.size).toBe(0)
  })
})

describe('selection — handleClick', () => {
  const items = ['a', 'b', 'c', 'd', 'e'] as const

  test('plain click replaces selection with just that id', () => {
    const s = selection<string>({ initial: ['a', 'b'] })
    s.handleClick('c', {}, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('meta-click toggles the id without disturbing others', () => {
    const s = selection<string>()
    s.handleClick('a', { meta: true }, items)
    s.handleClick('c', { meta: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'c'])
    s.handleClick('a', { meta: true }, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('shift-click selects the range from the anchor', () => {
    const s = selection<string>()
    s.handleClick('b', {}, items)
    s.handleClick('d', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd'])
  })

  test('shift-click handles reverse range', () => {
    const s = selection<string>()
    s.handleClick('d', {}, items)
    s.handleClick('b', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd'])
  })

  test('shift-click preserves anchor for extending ranges', () => {
    const s = selection<string>()
    s.handleClick('b', {}, items)
    s.handleClick('c', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c'])
    s.handleClick('e', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd', 'e'])
  })

  test('a second shift-click can shrink the range back toward the anchor', () => {
    const s = selection<string>()
    s.handleClick('b', {}, items) // anchor = b
    s.handleClick('e', { shift: true }, items) // range b..e
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd', 'e'])
    s.handleClick('c', { shift: true }, items) // re-anchor range to b..c
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c'])
  })

  test('plain or meta-click ends the shift run (so anchor-replays start fresh)', () => {
    const s = selection<string>()
    s.handleClick('b', {}, items)
    s.handleClick('e', { shift: true }, items)
    s.handleClick('a', { meta: true }, items) // ends shift run, adds a → {a,b,c,d,e}
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    // Next shift-click from new anchor 'a' should snapshot the *current* set
    // (which includes b–e), then add the range — no rollback to old snapshot.
    s.handleClick('b', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('shift-click without an anchor falls back to plain select', () => {
    const s = selection<string>()
    s.handleClick('c', { shift: true }, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('shift-click when anchor is not in ordered falls back to plain select', () => {
    const s = selection<string>()
    s.handleClick('zz', {}, ['zz']) // anchor = zz, no longer visible
    s.handleClick('c', { shift: true }, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('meta-click sets anchor on add, leaves it on remove', () => {
    const s = selection<string>()
    s.handleClick('a', { meta: true }, items) // anchor = a
    s.handleClick('c', { meta: true }, items) // anchor = c
    s.handleClick('c', { meta: true }, items) // remove c, anchor stays c
    s.handleClick('e', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'c', 'd', 'e'])
  })
})

describe('selection — read-only projection', () => {
  test('selectedIds does not expose set/update', () => {
    const s = selection<string>()
    const proj = s.selectedIds as { set?: unknown; update?: unknown }
    expect(proj.set).toBeUndefined()
    expect(proj.update).toBeUndefined()
  })
})
