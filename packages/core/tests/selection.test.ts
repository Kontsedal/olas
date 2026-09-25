import { describe, expect, test, vi } from 'vitest'
import { createSelection } from '../src/selection'

describe('selection — basics', () => {
  test('starts empty by default', () => {
    const s = createSelection<string>()
    expect(s.selectedIds.value.size).toBe(0)
    expect(s.size.value).toBe(0)
  })

  test('honors initial selection', () => {
    const s = createSelection<string>({ initial: ['a', 'b'] })
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b'])
    expect(s.size.value).toBe(2)
  })

  test('isSelected tracks the membership of a given id', () => {
    const s = createSelection<string>()
    const observed: boolean[] = []
    const stop = s.isSelected('x').subscribe((v) => observed.push(v))
    expect(observed).toEqual([false])
    s.select('x')
    expect(observed).toEqual([false, true])
    s.deselect('x')
    expect(observed).toEqual([false, true, false])
    stop()
  })

  test('isSelected returns the same signal for the same id', () => {
    // A view calling `use(sel.isSelected(id))` on every render must get a
    // stable handle, or the hook re-subscribes each render.
    const s = createSelection<string>()
    const first = s.isSelected('x')
    expect(s.isSelected('x')).toBe(first)
    expect(s.isSelected('y')).not.toBe(first)
    s.select('x')
    expect(first.value).toBe(true)
  })

  test('size is reactive', () => {
    const s = createSelection<string>()
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
    const s = createSelection<string>()
    s.select('a')
    s.select('a')
    expect([...s.selectedIds.value]).toEqual(['a'])
  })

  test('deselect removes and is a no-op when absent', () => {
    const s = createSelection<string>({ initial: ['a'] })
    s.deselect('missing')
    expect([...s.selectedIds.value]).toEqual(['a'])
    s.deselect('a')
    expect([...s.selectedIds.value]).toEqual([])
  })

  test('toggle adds then removes', () => {
    const s = createSelection<string>()
    s.toggle('a')
    expect(s.selectedIds.value.has('a')).toBe(true)
    s.toggle('a')
    expect(s.selectedIds.value.has('a')).toBe(false)
  })

  test('clear empties the set', () => {
    const s = createSelection<string>({ initial: ['a', 'b', 'c'] })
    s.clear()
    expect(s.selectedIds.value.size).toBe(0)
  })

  test('clear is a no-op when already empty (no signal write)', () => {
    const s = createSelection<string>()
    const fn = vi.fn()
    const stop = s.selectedIds.subscribe(fn)
    fn.mockClear()
    s.clear()
    expect(fn).not.toHaveBeenCalled()
    stop()
  })

  test('selectAll replaces the set', () => {
    const s = createSelection<string>({ initial: ['x'] })
    s.selectAll(['a', 'b'])
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b'])
  })

  test('selectAll with empty list clears', () => {
    const s = createSelection<string>({ initial: ['a'] })
    s.selectAll([])
    expect(s.selectedIds.value.size).toBe(0)
  })
})

describe('selection — handleClick', () => {
  const items = ['a', 'b', 'c', 'd', 'e'] as const

  test('plain click replaces selection with just that id', () => {
    const s = createSelection<string>({ initial: ['a', 'b'] })
    s.handleClick('c', {}, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('meta-click toggles the id without disturbing others', () => {
    const s = createSelection<string>()
    s.handleClick('a', { meta: true }, items)
    s.handleClick('c', { meta: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'c'])
    s.handleClick('a', { meta: true }, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('shift-click selects the range from the anchor', () => {
    const s = createSelection<string>()
    s.handleClick('b', {}, items)
    s.handleClick('d', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd'])
  })

  test('shift-click handles reverse range', () => {
    const s = createSelection<string>()
    s.handleClick('d', {}, items)
    s.handleClick('b', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd'])
  })

  test('shift-click preserves anchor for extending ranges', () => {
    const s = createSelection<string>()
    s.handleClick('b', {}, items)
    s.handleClick('c', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c'])
    s.handleClick('e', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd', 'e'])
  })

  test('a second shift-click can shrink the range back toward the anchor', () => {
    const s = createSelection<string>()
    s.handleClick('b', {}, items) // anchor = b
    s.handleClick('e', { shift: true }, items) // range b..e
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd', 'e'])
    s.handleClick('c', { shift: true }, items) // re-anchor range to b..c
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c'])
  })

  test('plain or meta-click ends the shift run (so anchor-replays start fresh)', () => {
    const s = createSelection<string>()
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
    const s = createSelection<string>()
    s.handleClick('c', { shift: true }, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('shift-click when anchor is not in ordered falls back to plain select', () => {
    const s = createSelection<string>()
    s.handleClick('zz', {}, ['zz']) // anchor = zz, no longer visible
    s.handleClick('c', { shift: true }, items)
    expect([...s.selectedIds.value]).toEqual(['c'])
  })

  test('meta-click sets anchor on add, leaves it on remove', () => {
    const s = createSelection<string>()
    s.handleClick('a', { meta: true }, items) // anchor = a
    s.handleClick('c', { meta: true }, items) // anchor = c
    s.handleClick('c', { meta: true }, items) // remove c, anchor stays c
    s.handleClick('e', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'c', 'd', 'e'])
  })

  test('a programmatic toggle ends the shift run, so the next range keeps it', () => {
    const letters = ['a', 'b', 'c', 'x', 'y', 'z']
    const s = createSelection<string>()
    s.handleClick('a', {}, letters)
    s.handleClick('c', { shift: true }, letters) // {a,b,c}
    s.toggle('z') // {a,b,c,z}, anchor = z
    s.handleClick('y', { shift: true }, letters)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'c', 'y', 'z'])
  })

  test('selectAll ends the shift run', () => {
    const s = createSelection<string>()
    s.handleClick('a', {}, items)
    s.handleClick('b', { shift: true }, items) // snapshot {a}
    s.selectAll(['a', 'b', 'c', 'd', 'e']) // anchor = e
    s.handleClick('d', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('select ends the shift run', () => {
    const s = createSelection<string>()
    s.handleClick('a', {}, items)
    s.handleClick('b', { shift: true }, items) // snapshot {a}, selection {a,b}
    s.select('e') // anchor = e
    s.handleClick('d', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'd', 'e'])
  })

  test('deselect ends the shift run, so a deselected id does not come back', () => {
    const s = createSelection<string>()
    s.handleClick('e', {}, items)
    s.handleClick('a', { meta: true }, items) // {a,e}, anchor = a
    s.handleClick('b', { shift: true }, items) // snapshot {a,e}, selection {a,b,e}
    s.deselect('e')
    s.handleClick('c', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'c'])
  })

  test('a deselect of an id that is not selected ends the shift run too', () => {
    const s = createSelection<string>()
    s.handleClick('a', {}, items)
    s.handleClick('c', { shift: true }, items) // snapshot {a}, selection {a,b,c}
    s.deselect('zz')
    // The next range starts from {a,b,c}, not from the snapshot, so it keeps c.
    s.handleClick('b', { shift: true }, items)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('selection — a Map index', () => {
  test("shift-click ranges by the Map's index values, not its insertion order", () => {
    // Display order c, a, b, d; the Map was filled in id order.
    const index: ReadonlyMap<string, number> = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 0],
      ['d', 3],
    ])
    const s = createSelection<string>()
    s.handleClick('c', {}, index)
    s.handleClick('a', { shift: true }, index)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'c'])
    s.handleClick('d', { shift: true }, index)
    expect([...s.selectedIds.value].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('deselect() of the anchor clears it, while a meta-click off the anchor keeps it', () => {
    const order = ['a', 'b', 'c', 'd']
    const s = createSelection<string>()
    s.handleClick('b', {}, order)
    s.handleClick('b', { meta: true }, order) // off, and still the anchor
    s.handleClick('d', { shift: true }, order)
    expect([...s.selectedIds.value].sort()).toEqual(['b', 'c', 'd'])

    s.handleClick('b', {}, order)
    s.deselect('b') // the anchor goes with it
    s.handleClick('d', { shift: true }, order)
    expect([...s.selectedIds.value]).toEqual(['d'])
  })
})

describe('selection — read-only projection', () => {
  test('selectedIds does not expose set/update', () => {
    const s = createSelection<string>()
    const proj = s.selectedIds as { set?: unknown; update?: unknown }
    expect(proj.set).toBeUndefined()
    expect(proj.update).toBeUndefined()
  })
})
