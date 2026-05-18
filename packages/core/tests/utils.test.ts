import { describe, expect, test } from 'vitest'
import { isAbortError } from '../src/utils'

describe('isAbortError', () => {
  test('true for DOMException("...", "AbortError")', () => {
    const err = new DOMException('aborted', 'AbortError')
    expect(isAbortError(err)).toBe(true)
  })

  test('true for AbortController.signal abort reason after abort()', () => {
    const c = new AbortController()
    c.abort()
    // signal.reason is a DOMException with name 'AbortError' by default
    expect(isAbortError(c.signal.reason)).toBe(true)
  })

  test('false for plain errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError({ name: 'AbortError' })).toBe(false)
  })

  test('false for non-AbortError DOMExceptions', () => {
    expect(isAbortError(new DOMException('boom', 'NotFoundError'))).toBe(false)
  })
})
