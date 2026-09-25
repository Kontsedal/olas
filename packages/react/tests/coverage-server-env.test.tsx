// @vitest-environment node

// Runs without a DOM: no `window`, no `document`, no `self`. The branches that
// pick a server-side fallback only evaluate here.

import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  HydrationBoundary,
  installStreamingIntake,
  STREAMING_GLOBAL,
  type SuspendableController,
  SuspendOnUnmount,
  useRoot,
  useSuspendOnHidden,
} from '../src'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[STREAMING_GLOBAL]
  vi.restoreAllMocks()
})

const makeController = () => {
  const c = { suspend: vi.fn(), resume: vi.fn() }
  return c satisfies SuspendableController
}

describe('keep-alive on the server', () => {
  test('SuspendOnUnmount renders its children and leaves the controller alone', () => {
    expect(typeof window).toBe('undefined')
    const c = makeController()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const html = renderToString(
      <SuspendOnUnmount controller={c}>
        <p>child</p>
      </SuspendOnUnmount>,
    )
    expect(html).toBe('<p>child</p>')
    expect(c.resume).not.toHaveBeenCalled()
    expect(c.suspend).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  test('useSuspendOnHidden renders on the server without suspending', () => {
    const c = makeController()
    function Probe() {
      useSuspendOnHidden(c)
      return <span>ok</span>
    }
    expect(renderToString(<Probe />)).toBe('<span>ok</span>')
    expect(c.suspend).not.toHaveBeenCalled()
    expect(c.resume).not.toHaveBeenCalled()
  })
})

describe('HydrationBoundary on the server', () => {
  test('warns once that its root is never disposed, and names the fix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const def = defineController(() => ({ label: 'ssr' }))
    const page = () => (
      <HydrationBoundary def={def} options={{ deps: {} }}>
        <p>child</p>
      </HydrationBoundary>
    )
    expect(renderToString(page())).toBe('<p>child</p>')
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toMatch(/<HydrationBoundary> rendered on the server/)
    expect(message).toMatch(/never disposed/)
    expect(message).toMatch(/<OlasProvider root=\{root\}>/)
    expect(message).toMatch(/root\.dispose\(\) after the response/)
    // The next request renders the same way and does not repeat the warning.
    expect(renderToString(page())).toBe('<p>child</p>')
    expect(warn).toHaveBeenCalledTimes(1)
  })
  test('an element hoisted to module scope builds a root per server render', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let built = 0
    const def = defineController(() => ({ request: ++built }))
    function Show() {
      return <p>{useRoot<{ request: number }>().request}</p>
    }
    // One element object, rendered for two requests: the second must not
    // read the first request's root.
    const page = (
      <HydrationBoundary def={def} options={{ deps: {} }}>
        <Show />
      </HydrationBoundary>
    )
    expect(renderToString(page)).toBe('<p>1</p>')
    expect(renderToString(page)).toBe('<p>2</p>')
  })
})

describe('installStreamingIntake without `self`', () => {
  test('uses globalThis for the intake: drains the queue and forwards later pushes', () => {
    expect(typeof self).toBe('undefined')
    const q = defineQuery({
      id: 'cov-server-env/intake',
      key: () => [],
      fetcher: () => new Promise<string>(() => {}),
    })
    const def = defineController((ctx) => ({ v: createQuery(ctx, q) }))
    const g = globalThis as Record<string, unknown>
    g[STREAMING_GLOBAL] = {
      q: [[{ queryId: 'cov-server-env/intake', key: [], data: 'queued', lastUpdatedAt: 1 }]],
      push(b: unknown) {
        ;(this as { q: unknown[] }).q.push(b)
      },
    }
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    const uninstall = installStreamingIntake(root)
    expect(root.api.v.data.peek()).toBe('queued')

    const intake = g[STREAMING_GLOBAL] as { push: (b: unknown) => void }
    intake.push([{ queryId: 'cov-server-env/intake', key: [], data: 'pushed', lastUpdatedAt: 2 }])
    expect(root.api.v.data.peek()).toBe('pushed')

    uninstall()
    root.dispose()
  })
})
