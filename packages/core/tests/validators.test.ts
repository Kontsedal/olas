import { describe, expect, test } from 'vitest'
import { email, max, maxLength, min, minLength, pattern, required } from '../src/forms/validators'

const sig = new AbortController().signal

describe('required', () => {
  const v = required<unknown>()
  test.each([
    ['', 'Required'],
    [null, 'Required'],
    [undefined, 'Required'],
    [[], 'Required'],
  ])('rejects %j', async (value, msg) => {
    expect(await v(value, sig)).toBe(msg)
  })

  test.each([['x'], [' '], [0], [false], [[1]]])('accepts %j', async (value) => {
    expect(await v(value, sig)).toBeNull()
  })

  test('accepts a custom message', async () => {
    const r = required<string>('Name is required')
    expect(await r('', sig)).toBe('Name is required')
  })
})

describe('minLength / maxLength', () => {
  test('minLength rejects shorter inputs', async () => {
    const v = minLength(3)
    expect(await v('ab', sig)).toMatch(/at least 3/)
    expect(await v('abc', sig)).toBeNull()
    expect(await v('abcd', sig)).toBeNull()
  })

  test('maxLength rejects longer inputs', async () => {
    const v = maxLength(3)
    expect(await v('abc', sig)).toBeNull()
    expect(await v('abcd', sig)).toMatch(/no more than 3/)
  })

  test('work on arrays too', async () => {
    expect(await minLength(2)([1], sig)).not.toBeNull()
    expect(await minLength(2)([1, 2], sig)).toBeNull()
    expect(await maxLength(2)([1, 2, 3], sig)).not.toBeNull()
  })
})

describe('min / max', () => {
  test('min rejects values below threshold', async () => {
    const v = min(5)
    expect(await v(4, sig)).toMatch(/at least 5/)
    expect(await v(5, sig)).toBeNull()
    expect(await v(10, sig)).toBeNull()
  })

  test('max rejects values above threshold', async () => {
    const v = max(5)
    expect(await v(5, sig)).toBeNull()
    expect(await v(6, sig)).toMatch(/no more than 5/)
  })
})

describe('email', () => {
  const v = email()
  test.each(['x@y.z', 'a.b@example.com', 'foo+tag@bar.io'])('accepts %s', async (value) => {
    expect(await v(value, sig)).toBeNull()
  })

  test.each([
    'no-at-sign',
    '@nodomain',
    'no@tld',
    'spaces in@email.com',
  ])('rejects %s', async (value) => {
    expect(await v(value, sig)).toMatch(/invalid/i)
  })

  test('accepts an empty string (use required() for emptiness checks)', async () => {
    expect(await v('', sig)).toBeNull()
  })
})

describe('pattern', () => {
  test('rejects values not matching the regex', async () => {
    const v = pattern(/^\d+$/)
    expect(await v('abc', sig)).toMatch(/invalid/i)
    expect(await v('123', sig)).toBeNull()
  })

  test('honors custom message', async () => {
    const v = pattern(/^[a-z]+$/, 'lowercase only')
    expect(await v('AB', sig)).toBe('lowercase only')
  })
})
