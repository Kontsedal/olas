// Price-alert evaluation, factored out of the ticker controller so the
// crossing rule is independently testable and the controller body stays
// focused on wiring.

import type { Tick } from './api'

export type Alert = {
  id: string
  symbol: string
  /** Numeric price target. */
  target: number
  /** Fire when price crosses `target` going this direction. */
  direction: 'above' | 'below'
  /** True once fired. Sticky — alerts are one-shot. */
  fired: boolean
}

export type AlertFiredEvent = {
  alert: Alert
  price: number
  ts: number
}

/** Evaluate every alert against an incoming tick. */
export function evaluateAlerts(
  alerts: readonly Alert[],
  tick: Tick,
  prevPrice: number | undefined,
): {
  next: Alert[]
  fired: AlertFiredEvent[]
  changed: boolean
} {
  const fired: AlertFiredEvent[] = []
  let changed = false
  const next = alerts.map((a): Alert => {
    if (a.fired || a.symbol !== tick.symbol) return a
    if (prevPrice === undefined) return a
    const above = a.direction === 'above' && prevPrice < a.target && tick.price >= a.target
    const below = a.direction === 'below' && prevPrice > a.target && tick.price <= a.target
    if (!above && !below) return a
    changed = true
    fired.push({ alert: a, price: tick.price, ts: Date.now() })
    return { ...a, fired: true }
  })
  return { next, fired, changed }
}

/** Append a new alert to the list. Pure — used by the controller's mutator. */
export function addAlert(
  list: readonly Alert[],
  input: Omit<Alert, 'id' | 'fired'>,
  id: string,
): Alert[] {
  return [...list, { id, ...input, fired: false }]
}

/** Remove an alert by id. Pure. */
export function removeAlert(list: readonly Alert[], id: string): Alert[] {
  return list.filter((a) => a.id !== id)
}
