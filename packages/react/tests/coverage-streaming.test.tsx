// @vitest-environment jsdom

import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createStreamingHydrator, createStreamingTransform, STREAMING_GLOBAL } from '../src'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[STREAMING_GLOBAL]
  vi.restoreAllMocks()
})

type Shipped = { queryId: string; key: unknown[]; data: unknown; lastUpdatedAt: number }

/** Pull the batch array out of one `flush()` script tag. */
function entriesOf(html: string): Shipped[] {
  const start = html.lastIndexOf('.push(') + '.push('.length
  const end = html.lastIndexOf(')</script>')
  return JSON.parse(html.slice(start, end)) as Shipped[]
}

describe('createStreamingHydrator — which writes it ships', () => {
  test('canonical write and replace are captured, and a key keeps only its latest value', async () => {
    const q = defineQuery({
      id: 'cov-streaming/canonical',
      key: () => [],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ v: createQuery(ctx, q) }))
    const { plugin, flush, dispose } = createStreamingHydrator()
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    await root.waitForIdle()
    expect(entriesOf(flush()).map((e) => e.data)).toEqual(['fetched'])

    q.write(() => 'written')
    expect(entriesOf(flush())).toEqual([
      {
        queryId: 'cov-streaming/canonical',
        key: [],
        data: 'written',
        lastUpdatedAt: expect.any(Number),
      },
    ])

    q.replace('replaced')
    expect(entriesOf(flush()).map((e) => e.data)).toEqual(['replaced'])

    // Two writes to one key before a flush ship as one entry carrying the last value.
    q.write(() => 'first')
    q.replace('second')
    const deduped = entriesOf(flush())
    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.data).toBe('second')

    // dispose() drops whatever was captured but not yet flushed.
    q.write(() => 'dropped')
    dispose()
    expect(flush()).toBe('')
    root.dispose()
  })

  test('optimistic, rollback and hydrate writes are not captured', async () => {
    const q = defineQuery({
      id: 'cov-streaming/uncaptured',
      key: () => [],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ v: createQuery(ctx, q) }))
    const { plugin, flush, dispose } = createStreamingHydrator()
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    await root.waitForIdle()
    flush() // drain the initial fetch

    const snapshot = q.setData(() => 'guess')
    expect(root.api.v.data.peek()).toBe('guess')
    expect(flush()).toBe('')

    snapshot.rollback()
    expect(root.api.v.data.peek()).toBe('fetched')
    expect(flush()).toBe('')

    root.hydrate({
      version: 1,
      entries: [
        { id: 'cov-streaming/uncaptured', key: [], data: 'hydrated', lastUpdatedAt: Date.now() },
      ],
    })
    expect(root.api.v.data.peek()).toBe('hydrated')
    expect(flush()).toBe('')

    dispose()
    root.dispose()
  })

  test('flush returns the empty string when every pending entry is un-serializable', async () => {
    const bad = defineQuery({
      id: 'cov-streaming/all-bad',
      key: () => [],
      fetcher: async () => ({ n: 1n }),
    })
    const def = defineController((ctx) => ({ bad: createQuery(ctx, bad) }))
    const { plugin, flush, dispose } = createStreamingHydrator()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    await root.waitForIdle()

    expect(() => flush()).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    // The skipped entry was drained, not left pending for the next flush.
    expect(flush()).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)

    dispose()
    root.dispose()
  })
})

describe('createStreamingTransform — nothing pending', () => {
  test('upstream chunks pass through alone when flush has nothing to add', async () => {
    const flush = vi.fn(() => '')
    const enc = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('<a/>'))
        controller.enqueue(enc.encode('<b/>'))
        controller.close()
      },
    })
    const reader = source.pipeThrough(createStreamingTransform(flush)).getReader()
    const dec = new TextDecoder()
    const seen: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(dec.decode(value))
    }
    expect(seen).toEqual(['<a/>', '<b/>'])
    // Once per chunk, plus the final drain on close.
    expect(flush).toHaveBeenCalledTimes(3)
  })
})
