// @vitest-environment node

/**
 * Server render of the `Bridge`.
 *
 * The sanctioned SSR path seeds `createRouterAdapter(initial)` and never
 * renders the `Bridge` — `adapter.test.tsx` pins that. A consumer whose
 * shared layout mounts the `Bridge` unconditionally reaches it anyway, and
 * React 18 answers a `useLayoutEffect` in a server render with a warning on
 * `console.error`. The adapter therefore picks the effect by environment.
 *
 * React 19, which this workspace installs, dropped that warning, so the
 * `console.error` assertion below cannot fail here today. It still guards
 * the React 18 half of the `react: ">=18"` peer range, and the render
 * assertion guards the `Bridge` on the server whatever React does.
 *
 * This file runs in the node environment on purpose: the adapter picks its
 * effect once at import time, from `typeof window`, so a jsdom file would
 * always take the client branch.
 */

import { renderToString } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { createRouterAdapter } from '../src'

describe('Bridge under renderToString', () => {
  test('renders its children on the server without complaint', () => {
    expect(typeof window).toBe('undefined')
    const adapter = createRouterAdapter()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const html = renderToString(
        <adapter.Bridge params={{ userId: '42' }} pathname="/users/42">
          <p>ok</p>
        </adapter.Bridge>,
      )
      expect(html).toContain('ok')
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})
