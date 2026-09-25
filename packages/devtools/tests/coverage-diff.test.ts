import { describe, expect, test } from 'vitest'
import { type Diff, diffValues, hasChange } from '../src/diff'

function child(diff: Diff, key: string): Diff | undefined {
  if (diff.t !== 'object' && diff.t !== 'array') return undefined
  return diff.entries.find((e) => e.key === key)?.diff
}

describe('diffValues — array and record edges', () => {
  test('an index present only on the next side is an `add`', () => {
    const diff = diffValues([1], [1, 2])
    expect(diff.t).toBe('array')
    expect(child(diff, '0')).toEqual({ t: 'same', value: 1 })
    expect(child(diff, '1')).toEqual({ t: 'add', value: 2 })
    expect(hasChange(diff)).toBe(true)
  })

  test('a different array ref with identical contents collapses to `same`', () => {
    const next = [1, { a: 1 }]
    const diff = diffValues([1, { a: 1 }], next)
    expect(diff).toEqual({ t: 'same', value: next })
    expect(hasChange(diff)).toBe(false)
  })

  test('an unchanged nested array collapses to `same` inside a changed object', () => {
    const diff = diffValues({ tags: ['x', 'y'], n: 1 }, { tags: ['x', 'y'], n: 2 })
    expect(child(diff, 'tags')).toEqual({ t: 'same', value: ['x', 'y'] })
    expect(child(diff, 'n')).toEqual({ t: 'change', prev: 1, next: 2 })
  })

  test('null-prototype records are descended like plain objects', () => {
    const prev = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 })
    const next = Object.assign(Object.create(null) as Record<string, unknown>, { a: 2 })
    const diff = diffValues(prev, next)
    expect(diff.t).toBe('object')
    expect(child(diff, 'a')).toEqual({ t: 'change', prev: 1, next: 2 })
  })

  test('an array compared with an object is a leaf change, not a walk', () => {
    expect(diffValues([1], { 0: 1 }).t).toBe('change')
  })

  test('a class instance is an opaque leaf', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    const diff = diffValues(new Point(1), new Point(2))
    expect(diff.t).toBe('change')
  })
})
