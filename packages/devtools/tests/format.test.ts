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

  test('falls back to String() when JSON.stringify throws (circular)', () => {
    const obj: Record<string, unknown> = { name: 'cycle' }
    obj.self = obj
    const out = formatPayload(obj)
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
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
})
