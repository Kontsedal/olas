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
import { htmlBoundary } from '../src/streaming'
import { entriesOf } from './_streaming'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[STREAMING_GLOBAL]
  vi.restoreAllMocks()
})

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

  test('a committed optimistic layer is captured, and the guess before it is not', async () => {
    const q = defineQuery({
      id: 'cov-streaming/commit',
      key: () => [],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ v: createQuery(ctx, q) }))
    const { plugin, flush, dispose } = createStreamingHydrator()
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    await root.waitForIdle()
    flush() // drain the initial fetch

    const snapshot = q.setData(() => 'saved')
    expect(flush()).toBe('')
    // A mutation's success commits its layer: the server now renders 'saved'.
    snapshot.finalize()
    expect(entriesOf(flush())).toMatchObject([{ queryId: 'cov-streaming/commit', data: 'saved' }])

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

describe('htmlBoundary — markup React rarely writes', () => {
  const after = (html: string) => {
    const b = htmlBoundary()
    b.feed(html)
    return b
  }

  test('a literal < in text starts no tag', () => {
    expect(after('<p>a < b</p>').canInsert).toBe(true)
    expect(after('<p>a < b').canClose).toBe(false)
  })

  test("a single-quoted attribute value may hold '>' and '/'", () => {
    expect(after("<p title='x>y/'>").canClose).toBe(false)
    expect(after("<p title='x>y/'>z</p>").canInsert).toBe(true)
    expect(after("<p title='x>y").canClose).toBe(false)
  })

  test('a processing instruction ends at its >, and a long doctype marks a document', () => {
    expect(after('<?xml version="1.0"?><p>a</p>').canInsert).toBe(true)
    const doc = after('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><p>a</p>')
    // A whole document takes a batch only inside <body>.
    expect(doc.canInsert).toBe(false)
    expect(doc.canClose).toBe(true)
  })

  test('an unmatched end tag changes nothing, and a long comment is not a marker', () => {
    expect(after('</div><p>a</p>').canInsert).toBe(true)
    expect(after('<!-- a comment longer than a marker --><p>a</p>').canInsert).toBe(true)
    expect(after('<!--&--><p>a</p>').canInsert).toBe(false)
    expect(after('<!--&--><p>a</p><!--/&-->').canInsert).toBe(true)
  })
})
