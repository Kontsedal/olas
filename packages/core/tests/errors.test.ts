import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { dispatchError, type ErrorContextInput } from '../src/errors'

const ctx: ErrorContextInput = { kind: 'effect', controllerPath: ['root', 'feature'] }

let consoleErr: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleErr.mockRestore()
})

describe('dispatchError', () => {
  test('calls the user handler with err and context', () => {
    const handler = vi.fn()
    dispatchError(handler, new Error('boom'), ctx)
    expect(handler).toHaveBeenCalledTimes(1)
    const [err, passedCtx] = handler.mock.calls[0]!
    expect((err as Error).message).toBe('boom')
    expect(passedCtx).toMatchObject(ctx)
    // The dispatcher stamps a per-event correlation id + timestamp.
    expect(typeof (passedCtx as { eventId: string }).eventId).toBe('string')
    expect(typeof (passedCtx as { timestamp: number }).timestamp).toBe('number')
  })

  test('falls back to console.error when no handler is provided', () => {
    dispatchError(undefined, new Error('boom'), ctx)
    expect(consoleErr).toHaveBeenCalled()
  })

  test('a throwing handler does not propagate — it is logged instead', () => {
    const handler = () => {
      throw new Error('handler bug')
    }
    expect(() => dispatchError(handler, new Error('boom'), ctx)).not.toThrow()
    expect(consoleErr).toHaveBeenCalled()
  })
})
