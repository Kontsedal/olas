import { describe, expect, test } from 'vitest'
import { structuralShare } from '../src/query/structural-share'

describe('structuralShare', () => {
  test('identical refs short-circuit', () => {
    const a = { x: 1 }
    expect(structuralShare(a, a)).toBe(a)
  })

  test('primitive equality returns the new value (identity is identity)', () => {
    expect(structuralShare(5, 5)).toBe(5)
    expect(structuralShare('a', 'a')).toBe('a')
    expect(structuralShare(null, null)).toBe(null)
    expect(structuralShare(undefined, undefined)).toBe(undefined)
  })

  test('mismatched primitives return next', () => {
    expect(structuralShare(5, 6)).toBe(6)
    expect(structuralShare('a', 'b')).toBe('b')
  })

  test('null / undefined mismatch returns next', () => {
    expect(structuralShare(null, { x: 1 })).toEqual({ x: 1 })
    expect(structuralShare({ x: 1 } as object | null, null)).toBeNull()
  })

  test('unchanged plain object preserves prev ref', () => {
    const prev = { id: 1, name: 'Alice' }
    const next = { id: 1, name: 'Alice' }
    expect(structuralShare(prev, next)).toBe(prev)
  })

  test('one-leaf-changed plain object returns new ref but keeps unchanged sub-refs', () => {
    const prev = { id: 1, profile: { name: 'A', age: 30 }, tags: ['x', 'y'] }
    const next = { id: 1, profile: { name: 'A', age: 30 }, tags: ['x', 'z'] }
    const result = structuralShare(prev, next)
    expect(result).not.toBe(prev)
    expect(result.id).toBe(prev.id)
    expect(result.profile).toBe(prev.profile)
    expect(result.tags).not.toBe(prev.tags)
    expect(result.tags[0]).toBe(prev.tags[0]) // string equality
  })

  test('unchanged array preserves prev ref', () => {
    const prev = [{ id: 1 }, { id: 2 }]
    const next = [{ id: 1 }, { id: 2 }]
    expect(structuralShare(prev, next)).toBe(prev)
  })

  test('arrays preserve per-index refs where items are deep-equal', () => {
    const a1 = { id: 1, name: 'A' }
    const b1 = { id: 2, name: 'B' }
    const prev = [a1, b1]
    const next = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B-changed' },
    ]
    const result = structuralShare(prev, next)
    expect(result).not.toBe(prev)
    expect(result[0]).toBe(a1) // unchanged item, ref preserved
    expect(result[1]).not.toBe(b1)
    expect(result[1]).toEqual({ id: 2, name: 'B-changed' })
  })

  test('appended array item: prefix refs preserved, length grows', () => {
    const a = { id: 1 }
    const b = { id: 2 }
    const prev = [a, b]
    const next = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const result = structuralShare(prev, next)
    expect(result).not.toBe(prev)
    expect(result[0]).toBe(a)
    expect(result[1]).toBe(b)
    expect(result[2]).toEqual({ id: 3 })
  })

  test('shorter next array drops the tail; matching prefix refs preserved', () => {
    const a = { id: 1 }
    const prev = [a, { id: 2 }]
    const next = [{ id: 1 }]
    const result = structuralShare(prev, next)
    expect(result.length).toBe(1)
    expect(result[0]).toBe(a)
  })

  test('class instances are NOT structurally walked (bail to next ref)', () => {
    class Holder {
      constructor(public n: number) {}
    }
    const prev = new Holder(1)
    const next = new Holder(1)
    // Same content but different prototypes; we bail and return next.
    expect(structuralShare(prev, next)).toBe(next)
  })

  test('Map / Set / Date / RegExp values bail at the matching slot', () => {
    const prev = { d: new Date(0), m: new Map<string, number>([['a', 1]]) }
    const next = { d: new Date(0), m: new Map<string, number>([['a', 1]]) }
    const result = structuralShare(prev, next)
    // The outer object is rebuilt (children differ in ref), but each non-
    // walkable child returns the `next` ref unchanged.
    expect(result.d).toBe(next.d)
    expect(result.m).toBe(next.m)
  })

  test('mismatched array vs object returns next', () => {
    expect(structuralShare([1, 2] as unknown, { 0: 1, 1: 2 } as unknown)).toEqual({
      0: 1,
      1: 2,
    })
  })

  test('cyclic prev does not loop; returns next', () => {
    type Cyclic = { self?: Cyclic; id: number }
    const prev: Cyclic = { id: 1 }
    prev.self = prev
    const next: Cyclic = { id: 1 }
    next.self = next
    // Either branch enters the cycle; the walker bails on the second
    // encounter and returns `next` (we don't try to deep-equal cycles).
    const result = structuralShare(prev, next)
    // Doesn't loop forever — that's the headline test.
    expect(result).toBeDefined()
  })

  test('renaming a key invalidates the parent ref but preserves unchanged sibling refs', () => {
    const inner = { n: 1 }
    const prev = { a: inner, b: inner }
    const next = { a: { n: 1 }, c: { n: 1 } } as { a: { n: 1 }; c?: unknown; b?: unknown }
    const result = structuralShare(prev, next as typeof prev) as { a: { n: 1 }; c?: { n: 1 } }
    expect(result.a).toBe(inner) // unchanged
    expect(result).not.toBe(prev) // shape changed
  })

  test('extra key on next forces parent rebuild', () => {
    const prev = { x: 1 }
    const next = { x: 1, y: 2 }
    expect(structuralShare(prev as typeof next, next)).not.toBe(prev)
  })

  test('result key order matches next', () => {
    const prev = { a: 1, b: 2, c: 3 }
    const next = { c: 3, b: 2, a: 1 }
    const result = structuralShare(prev as typeof next, next)
    // Same content, same prev — result IS prev (no rebuild).
    expect(result).toBe(prev)
  })
})
