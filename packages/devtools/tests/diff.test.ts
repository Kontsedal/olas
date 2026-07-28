import { describe, expect, test } from 'vitest'
import { type Diff, diffValues, hasChange } from '../src/diff'

/** Find a child diff by key inside an object/array diff. */
function child(diff: Diff, key: string): Diff | undefined {
  if (diff.t !== 'object' && diff.t !== 'array') return undefined
  return diff.entries.find((e) => e.key === key)?.diff
}

describe('diffValues', () => {
  test('identical primitives are `same`', () => {
    expect(diffValues(1, 1)).toEqual({ t: 'same', value: 1 })
    expect(hasChange(diffValues('a', 'a'))).toBe(false)
  })

  test('changed primitive is a `change` with prev + next', () => {
    expect(diffValues(1, 2)).toEqual({ t: 'change', prev: 1, next: 2 })
    expect(hasChange(diffValues(1, 2))).toBe(true)
  })

  test('object: added, removed and changed keys are classified; unchanged is `same`', () => {
    const diff = diffValues({ a: 1, b: 2, keep: 9 }, { a: 1, b: 3, c: 4, keep: 9 })
    expect(diff.t).toBe('object')
    expect(hasChange(diff)).toBe(true)
    expect(child(diff, 'a')).toEqual({ t: 'same', value: 1 })
    expect(child(diff, 'b')).toEqual({ t: 'change', prev: 2, next: 3 })
    expect(child(diff, 'c')).toEqual({ t: 'add', value: 4 })
    expect(child(diff, 'keep')).toEqual({ t: 'same', value: 9 })
  })

  test('object: a removed key is classified', () => {
    const diff = diffValues({ a: 1, gone: 2 }, { a: 1 })
    expect(child(diff, 'gone')).toEqual({ t: 'remove', value: 2 })
    expect(hasChange(diff)).toBe(true)
  })

  test('array: index add / remove / change', () => {
    const diff = diffValues([1, 2, 3], [1, 9])
    expect(diff.t).toBe('array')
    expect(child(diff, '0')).toEqual({ t: 'same', value: 1 })
    expect(child(diff, '1')).toEqual({ t: 'change', prev: 2, next: 9 })
    expect(child(diff, '2')).toEqual({ t: 'remove', value: 3 })
  })

  test('nested objects recurse; an unchanged subtree is `same`', () => {
    const diff = diffValues(
      { user: { name: 'Ada', age: 36 }, meta: { v: 1 } },
      { user: { name: 'Ada', age: 37 }, meta: { v: 1 } },
    )
    const user = child(diff, 'user')!
    expect(child(user, 'age')).toEqual({ t: 'change', prev: 36, next: 37 })
    expect(child(user, 'name')).toEqual({ t: 'same', value: 'Ada' })
    // The wholly-unchanged `meta` subtree collapses to a single `same` node.
    expect(child(diff, 'meta')).toEqual({ t: 'same', value: { v: 1 } })
  })

  test('a shared reference (DAG) is diffed normally, not mis-flagged as a cycle', () => {
    const shared = { x: 1 }
    const diff = diffValues({ a: shared, b: shared }, { a: shared, b: { x: 2 } })
    expect(child(diff, 'a')).toEqual({ t: 'same', value: shared })
    expect(child(child(diff, 'b')!, 'x')).toEqual({ t: 'change', prev: 1, next: 2 })
  })

  test('a true cycle is handled without overflowing the stack', () => {
    const a: Record<string, unknown> = { n: 1 }
    a.self = a
    const b: Record<string, unknown> = { n: 2 }
    b.self = b
    expect(() => diffValues(a, b)).not.toThrow()
    const diff = diffValues(a, b)
    expect(child(diff, 'n')).toEqual({ t: 'change', prev: 1, next: 2 })
    // The self-reference bottoms out as a leaf change rather than recursing.
    expect(child(diff, 'self')?.t).toBe('change')
  })

  test('opaque built-ins (Date) are leaf changes, not descended', () => {
    const diff = diffValues(new Date(0), new Date(1000))
    expect(diff.t).toBe('change')
  })

  test('first write (prev undefined) is a whole-value change', () => {
    const diff = diffValues(undefined, { a: 1 })
    expect(diff.t).toBe('change')
    expect(hasChange(diff)).toBe(true)
  })

  test('a very deep (but acyclic) structure is capped, not stack-overflowed', () => {
    const build = (leaf: unknown): Record<string, unknown> => {
      let node: Record<string, unknown> = { leaf }
      for (let i = 0; i < 10_000; i++) node = { next: node }
      return node
    }
    expect(() => diffValues(build(1), build(2))).not.toThrow()
    expect(hasChange(diffValues(build(1), build(2)))).toBe(true)
  })
})
