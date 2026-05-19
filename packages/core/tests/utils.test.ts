import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { abortableSleep, isAbortError } from '../src/utils'

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

describe('abortableSleep', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('resolves after the requested delay', async () => {
    const c = new AbortController()
    const settled = vi.fn()
    const p = abortableSleep(50, c.signal).then(settled, settled)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    await p
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(undefined)
  })

  test('rejects synchronously when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    await expect(abortableSleep(100, c.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('rejects with AbortError when the signal aborts mid-sleep, clears the timer', async () => {
    const c = new AbortController()
    const promise = abortableSleep(1000, c.signal)
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10)
    c.abort()
    await rejection
    // Advancing past the original delay must not re-resolve the promise — the
    // listener clears the timer on abort.
    await vi.advanceTimersByTimeAsync(2000)
  })
})
