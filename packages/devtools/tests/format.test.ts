import { describe, expect, test } from 'vitest'
import { formatPath, formatPayload, formatTime } from '../src/format'

describe('formatPayload', () => {
  test('renders simple JSON values', () => {
    expect(formatPayload({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}')
    expect(formatPayload([1, 2, 3])).toBe('[1,2,3]')
    expect(formatPayload(42)).toBe('42')
    expect(formatPayload('hello')).toBe('"hello"')
    expect(formatPayload(true)).toBe('true')
  })

  test('renders null / undefined as themselves', () => {
    expect(formatPayload(undefined)).toBe('undefined')
    expect(formatPayload(null)).toBe('null')
  })

  test('renders a function as [fn]', () => {
    expect(formatPayload(() => 1)).toBe('[fn]')
  })

  test('replaces nested functions with [fn] in serialized output', () => {
    expect(formatPayload({ a: 1, fn: () => 2 })).toBe('{"a":1,"fn":"[fn]"}')
  })

  test('renders BigInt as its string representation', () => {
    expect(formatPayload({ n: 9007199254740993n })).toBe('{"n":"9007199254740993"}')
  })

  test('renders Error as { name, message }', () => {
    const err = new Error('boom')
    expect(formatPayload({ err })).toBe('{"err":{"name":"Error","message":"boom"}}')
  })

  test('truncates strings longer than maxLen with an ellipsis', () => {
    const s = 'a'.repeat(300)
    const out = formatPayload(s)
    expect(out.length).toBe(201)
    expect(out.endsWith('…')).toBe(true)
  })

  test('respects a custom maxLen', () => {
    expect(formatPayload('abcdef', 3)).toBe('"ab…')
  })

  test('marks a circular reference instead of throwing', () => {
    const obj: Record<string, unknown> = { name: 'cycle' }
    obj.self = obj
    expect(formatPayload(obj)).toBe('{"name":"cycle","self":"[Circular]"}')
  })

  test('falls back to a placeholder when even String() throws', () => {
    const hostile = new Proxy(Object.create(null), {
      get() {
        throw new Error('no reads')
      },
    })
    expect(formatPayload(hostile)).toBe('[unserializable]')
  })

  test('falls back to String() when JSON.stringify returns undefined (top-level fn)', () => {
    // typeof === 'function' branch already covers this — top-level symbol does too.
    const sym = Symbol('x')
    expect(formatPayload(sym)).toBe('Symbol(x)')
  })
})

describe('formatTime', () => {
  test('renders HH:MM:SS.mmm padded', () => {
    // 1970-01-01T00:00:00.001Z; local timezone shifts the hour but the format
    // (two-digit hour/min/sec and three-digit ms) is what we're verifying.
    const out = formatTime(1)
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
    // single-ms input should produce ".001"
    expect(out.endsWith('.001')).toBe(true)
  })

  test('pads single-digit milliseconds to width 3', () => {
    const out = formatTime(50)
    expect(out.endsWith('.050')).toBe(true)
  })
})

describe('formatPath', () => {
  test('renders the empty-path glyph for an empty path', () => {
    expect(formatPath([])).toBe('∅')
  })

  test('joins path segments with the › separator', () => {
    expect(formatPath(['root', 'feature[0]', 'leaf[2]'])).toBe('root › feature[0] › leaf[2]')
  })

  test('stringifies non-string path entries', () => {
    expect(formatPath([1, true, null])).toBe('1 › true › null')
  })

  test('renders an object member of a query key as compact JSON', () => {
    expect(formatPath(['users', { page: 1 }])).toBe('users › {"page":1}')
    expect(formatPath(['users', [1, 'a']])).toBe('users › [1,"a"]')
  })

  test('a null-prototype object member renders instead of throwing', () => {
    const params = Object.assign(Object.create(null) as Record<string, unknown>, { q: 'ada' })
    expect(formatPath(['search', params])).toBe('search › {"q":"ada"}')
  })

  test('a cycle, a bigint and a function inside a member stay printable', () => {
    const member: Record<string, unknown> = { n: 1n, fn: () => 1 }
    member.self = member
    expect(formatPath(['k', member])).toBe('k › {"n":"1","fn":"[fn]","self":"[Circular]"}')
  })

  test('a reference repeated in two places is not a cycle', () => {
    const shared = { v: 1 }
    expect(formatPath([{ a: shared, b: shared }])).toBe('{"a":{"v":1},"b":{"v":1}}')
  })

  test('a long member is cut with an ellipsis', () => {
    const out = formatPath([{ text: 'x'.repeat(500) }])
    expect(out.length).toBe(61)
    expect(out.endsWith('…')).toBe(true)
  })
})
