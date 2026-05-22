// @vitest-environment jsdom

import { createRoot, defineController, defineQuery } from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createStreamingHydrator, installStreamingIntake, STREAMING_GLOBAL } from '../src/streaming'

afterEach(() => {
  // Wipe the global between tests so leaks don't infect the next case.
  delete (globalThis as Record<string, unknown>)[STREAMING_GLOBAL]
})

describe('createStreamingHydrator (server side)', () => {
  test('captures local setData writes to queries with a queryId', async () => {
    const users = defineQuery({
      queryId: 'streaming-test-users',
      key: () => [],
      fetcher: async () => ['alice', 'bob'],
    })
    const def = defineController((ctx) => ({ users: ctx.use(users) }))

    const { plugin, flush, dispose } = createStreamingHydrator()
    const root = createRoot(def, { deps: {}, plugins: [plugin] })

    // Wait for the initial fetch to settle.
    await root.waitForIdle()

    const html = flush()
    expect(html).toContain('<script>')
    expect(html).toContain('"queryId":"streaming-test-users"')
    expect(html).toContain('"data":["alice","bob"]')

    // Second flush is empty (no new entries).
    expect(flush()).toBe('')

    dispose()
    root.dispose()
  })

  test("skips queries without a queryId — they can't round-trip", async () => {
    const anon = defineQuery({
      key: () => [],
      fetcher: async () => 'x',
    })
    const def = defineController((ctx) => ({ anon: ctx.use(anon) }))

    const { plugin, flush, dispose } = createStreamingHydrator()
    const root = createRoot(def, { deps: {}, plugins: [plugin] })
    await root.waitForIdle()

    // No queryId → cross-tab / streaming hooks don't fire.
    expect(flush()).toBe('')

    dispose()
    root.dispose()
  })

  test('escapes </ in serialized data to prevent script-tag breakout', async () => {
    const evil = defineQuery({
      queryId: 'streaming-evil',
      key: () => [],
      fetcher: async () => '</script><img src=x onerror=alert(1)>',
    })
    const def = defineController((ctx) => ({ evil: ctx.use(evil) }))

    const { plugin, flush } = createStreamingHydrator()
    const root = createRoot(def, { deps: {}, plugins: [plugin] })
    await root.waitForIdle()

    const html = flush()
    // The literal `</` must not appear unescaped between <script> tags.
    expect(html).toContain('<script>')
    expect(html).not.toContain('</script><img')
    expect(html).toContain('\\u003c/script')
    root.dispose()
  })
})

describe('installStreamingIntake (client side)', () => {
  beforeEach(() => {
    // Simulate a bootstrap script that ran before any boundary mounted —
    // some entries arrived in the queue.
    ;(globalThis as Record<string, unknown>)[STREAMING_GLOBAL] = {
      q: [
        [
          {
            queryId: 'streaming-test-users',
            key: [],
            data: ['preloaded-alice'],
            lastUpdatedAt: 1000,
          },
        ],
      ],
      push(batch: unknown) {
        const intake = (globalThis as unknown as Record<string, { q: unknown[] }>)[STREAMING_GLOBAL]
        if (intake !== undefined) intake.q.push(batch)
      },
    }
  })

  test('drains a pre-mount queue + forwards subsequent pushes to the root', async () => {
    const users = defineQuery({
      queryId: 'streaming-test-users',
      key: () => [],
      fetcher: async () => ['fresh-from-fetcher'],
    })
    const def = defineController((ctx) => ({ users: ctx.use(users) }))
    const root = createRoot(def, { deps: {} })
    // Don't subscribe yet — the entry isn't bound. installStreamingIntake
    // should buffer the preloaded data so a future subscribe picks it up.
    const uninstall = installStreamingIntake(root)

    // Now subscribe (mimics a component mounting after the intake drain).
    const sub = (root as { users: { data: { peek: () => unknown[] | undefined } } }).users
    // Wait a microtask for the intake's `applyDehydratedEntry` to settle
    // any buffered hydratedData slot — bind is synchronous here so peek
    // returns the preloaded value.
    await Promise.resolve()
    expect(sub.data.peek()).toEqual(['preloaded-alice'])

    // Push a fresh batch through the live forwarder.
    const intake = (globalThis as unknown as Record<string, { push: (b: unknown) => void }>)[
      STREAMING_GLOBAL
    ]
    if (intake === undefined) throw new Error('intake missing')
    intake.push([
      {
        queryId: 'streaming-test-users',
        key: [],
        data: ['live-stream-bob'],
        lastUpdatedAt: 2000,
      },
    ])
    expect(sub.data.peek()).toEqual(['live-stream-bob'])

    uninstall()
    root.dispose()
  })
})
