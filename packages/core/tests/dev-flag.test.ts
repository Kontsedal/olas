import { describe, expect, it } from 'vitest'

/**
 * The `__DEV__` constant is substituted at bundle time by tsdown's `define:`
 * — `JSON.stringify(process.env.NODE_ENV !== 'production')`. Under vitest the
 * root `vitest.config.ts` substitutes `true` so the existing devtools-events
 * tests (which assert emission actually arrives) still pass. See SPEC §23.x
 * for the full production behaviour. `devtools-events.test.ts` proves
 * emission still works in dev — this file pins the substitution itself.
 */
describe('__DEV__ flag', () => {
  it('is true under vitest (test env)', () => {
    expect(__DEV__).toBe(true)
  })
})
