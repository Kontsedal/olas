// @vitest-environment jsdom

import { createRoot, defineController, defineQuery, effect } from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createStreamingHydrator,
  createStreamingTransform,
  installStreamingIntake,
  STREAMING_GLOBAL,
} from '../src/streaming'

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

  test('intake apply runs inside a single signal batch per arriving batch', async () => {
    const q1 = defineQuery({
      queryId: 'streaming-batch-q1',
      key: () => [],
      fetcher: async () => 'v1',
    })
    const q2 = defineQuery({
      queryId: 'streaming-batch-q2',
      key: () => [],
      fetcher: async () => 'v2',
    })
    const def = defineController((ctx) => ({ a: ctx.use(q1), b: ctx.use(q2) }))
    const root = createRoot(def, { deps: {} })
    // Override the pre-populated queue from `beforeEach` — irrelevant to
    // this test.
    ;(globalThis as unknown as Record<string, unknown>)[STREAMING_GLOBAL] = {
      q: [],
      push(batch: unknown) {
        const g = (globalThis as unknown as Record<string, { q: unknown[] }>)[STREAMING_GLOBAL]
        if (g !== undefined) g.q.push(batch)
      },
    }
    const uninstall = installStreamingIntake(root)
    const sub = root as {
      a: { data: { value: unknown; peek: () => unknown } }
      b: { data: { value: unknown; peek: () => unknown } }
    }
    // Wait for initial fetches to settle to keep effect counts focused on
    // the batched apply.
    await root.waitForIdle()

    // Count effect runs. An effect that reads both signals re-runs once
    // per batch where either changes — so a single push that updates
    // both should produce exactly one run after the steady-state read.
    let runs = 0
    const dispose = effect(() => {
      void sub.a.data.value
      void sub.b.data.value
      runs += 1
    })
    const baseline = runs
    // Push two entries at once.
    const intake = (globalThis as unknown as Record<string, { push: (b: unknown) => void }>)[
      STREAMING_GLOBAL
    ]
    if (intake === undefined) throw new Error('intake missing')
    intake.push([
      { queryId: 'streaming-batch-q1', key: [], data: 'next-v1', lastUpdatedAt: 100 },
      { queryId: 'streaming-batch-q2', key: [], data: 'next-v2', lastUpdatedAt: 100 },
    ])
    // Effect runs once for the batch, not twice.
    expect(runs - baseline).toBe(1)
    expect(sub.a.data.peek()).toBe('next-v1')
    expect(sub.b.data.peek()).toBe('next-v2')

    dispose()
    uninstall()
    root.dispose()
  })
})

describe('createStreamingTransform', () => {
  test('interleaves flushed scripts after each upstream chunk', async () => {
    const flushed = ['<script>1</script>', '<script>2</script>', '']
    let i = 0
    const flush = () => flushed[i++] ?? ''

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode('<chunk-a/>'))
        controller.enqueue(enc.encode('<chunk-b/>'))
        controller.close()
      },
    })
    const out = source.pipeThrough(createStreamingTransform(flush))
    const reader = out.getReader()
    const dec = new TextDecoder()
    const seen: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(dec.decode(value))
    }
    // Order: chunk-a, then flushed[0], then chunk-b, then flushed[1], then
    // final-drain flushed[2] (empty — skipped).
    expect(seen).toEqual(['<chunk-a/>', '<script>1</script>', '<chunk-b/>', '<script>2</script>'])
  })

  test('drains a final non-empty flush on stream close', async () => {
    let drained = false
    const flush = () => {
      if (drained) return ''
      drained = true
      return '<script>trailing</script>'
    }
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const out = source.pipeThrough(createStreamingTransform(flush))
    const reader = out.getReader()
    const dec = new TextDecoder()
    const seen: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(dec.decode(value))
    }
    expect(seen).toEqual(['<script>trailing</script>'])
  })
})
