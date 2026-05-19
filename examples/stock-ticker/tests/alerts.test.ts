// Pure unit tests for the alert evaluator — no controller, no signals,
// no fake timers. The extracted helper makes the crossing rule directly
// verifiable.

import { describe, expect, test } from 'vitest'
import { type Alert, addAlert, evaluateAlerts, removeAlert } from '../src/alerts'

const tick = (symbol: string, price: number) => ({ symbol, price, ts: 0 })

const armed = (overrides: Partial<Alert> = {}): Alert => ({
  id: 'a1',
  symbol: 'AAPL',
  target: 100,
  direction: 'above',
  fired: false,
  ...overrides,
})

describe('evaluateAlerts', () => {
  test('does not fire when prevPrice is undefined (first observation)', () => {
    const out = evaluateAlerts([armed()], tick('AAPL', 200), undefined)
    expect(out.changed).toBe(false)
    expect(out.fired).toEqual([])
  })

  test('fires "above" when crossing the target going up', () => {
    const out = evaluateAlerts([armed({ target: 150 })], tick('AAPL', 160), 100)
    expect(out.changed).toBe(true)
    expect(out.fired).toHaveLength(1)
    expect(out.fired[0]!.price).toBe(160)
    expect(out.next[0]!.fired).toBe(true)
  })

  test('fires "below" when crossing the target going down', () => {
    const out = evaluateAlerts([armed({ target: 90, direction: 'below' })], tick('AAPL', 80), 100)
    expect(out.changed).toBe(true)
    expect(out.fired).toHaveLength(1)
  })

  test('does NOT re-fire an already-fired alert', () => {
    const out = evaluateAlerts([armed({ target: 100, fired: true })], tick('AAPL', 200), 50)
    expect(out.changed).toBe(false)
  })

  test('ignores alerts for other symbols', () => {
    const out = evaluateAlerts([armed({ symbol: 'MSFT', target: 100 })], tick('AAPL', 200), 50)
    expect(out.changed).toBe(false)
  })

  test('addAlert appends + removeAlert filters by id', () => {
    const initial: Alert[] = []
    const after = addAlert(initial, { symbol: 'AAPL', target: 100, direction: 'above' }, 'x')
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe('x')
    expect(removeAlert(after, 'x')).toEqual([])
  })
})
