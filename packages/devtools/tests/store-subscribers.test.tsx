// @vitest-environment jsdom

import {
  createQuery,
  createRoot,
  type DebugCacheEntry,
  type DebugEvent,
  defineController,
  defineQuery,
  queryEngine,
  signal,
} from '@kontsedal/olas-core'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'
import { DevtoolsStore } from '../src/store'
import { entryKey } from '../src/util'

const subscribed = (queryKey: unknown[], path: string[]): DebugEvent => ({
  type: 'cache:subscribed',
  queryId: 'q',
  queryKey,
  subscriberPath: path,
})
const unsubscribed = (queryKey: unknown[], path: string[]): DebugEvent => ({
  type: 'cache:unsubscribed',
  queryId: 'q',
  queryKey,
  subscriberPath: path,
})

afterEach(() => cleanup())

describe('DevtoolsStore subscriber counts', () => {
  test('counts subscriptions per entry from the events', () => {
    const store = new DevtoolsStore()
    store.handle(subscribed(['a'], ['root', 'x']))
    store.handle(subscribed(['a'], ['root', 'y']))
    store.handle(subscribed(['b'], ['root', 'x']))
    store.handle(unsubscribed(['a'], ['root', 'x']))
    expect(store.subscribers$.peek()).toEqual(
      new Map([
        [entryKey('q', ['a']), 1],
        [entryKey('q', ['b']), 1],
      ]),
    )
    store.handle(unsubscribed(['a'], ['root', 'y']))
    store.handle(unsubscribed(['a'], ['root', 'y'])) // never below zero
    expect(store.subscribers$.peek().has(entryKey('q', ['a']))).toBe(false)
    expect(store.cache$.peek().map((e) => e.kind)).toEqual([
      'subscribed',
      'subscribed',
      'subscribed',
      'unsubscribed',
      'unsubscribed',
      'unsubscribed',
    ])
  })

  test('a gc drops the count, and the count moves while paused', () => {
    const store = new DevtoolsStore()
    store.pause()
    store.handle(subscribed(['a'], ['root']))
    expect(store.cache$.peek()).toEqual([])
    expect(store.subscribers$.peek().get(entryKey('q', ['a']))).toBe(1)
    store.resume()
    store.handle({ type: 'cache:gc', queryId: 'q', queryKey: ['a'] })
    expect(store.subscribers$.peek().size).toBe(0)
    store.handle({ type: 'cache:gc', queryId: 'q', queryKey: ['a'] }) // nothing left to drop
    expect(store.subscribers$.peek().size).toBe(0)
  })

  test('attach seeds the counts from the snapshot, and each refresh corrects them', () => {
    const handlers = new Set<(e: DebugEvent) => void>()
    const entry = (key: string, subscribers?: number): DebugCacheEntry => ({
      queryId: 'q',
      key: [key],
      status: 'success',
      data: undefined,
      error: undefined,
      lastUpdatedAt: undefined,
      isStale: false,
      isFetching: false,
      hasPendingMutations: false,
      ...(subscribers !== undefined ? { subscribers } : {}),
    })
    let entries = [entry('a', 2), entry('b', 0), entry('c')]
    const store = new DevtoolsStore()
    store.attach({
      debug: {
        subscribe: (h) => {
          handlers.add(h)
          return () => handlers.delete(h)
        },
        queryEntries: () => entries,
      },
    })
    expect(store.subscribers$.peek()).toEqual(new Map([[entryKey('q', ['a']), 2]]))

    entries = [entry('a', 0), entry('b', 1)]
    for (const h of handlers) h(subscribed(['b'], ['root']))
    expect(store.subscribers$.peek()).toEqual(new Map([[entryKey('q', ['b']), 1]]))
  })
})

describe('the inspector shows the subscriber count', () => {
  test('a live root: two subscribers, then one', () => {
    const q = defineQuery({ id: 'subs/panel', key: () => ['k'], fetcher: async () => 1 })
    const both = signal(true)
    const view = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = createRoot(
      defineController((ctx) => ({
        a: ctx.child(view, undefined),
        b: ctx.child(
          defineController((c) => ({ s: createQuery(c, q, { enabled: () => both.value }) })),
          undefined,
        ),
      })),
      { queries: queryEngine(), deps: {} },
    )
    render(<DevtoolsPanel root={root} defaultTab="inspector" />)
    const suffix = () => screen.getByRole('tabpanel').querySelector('.olas-devtools-duration')
    expect(suffix()?.textContent).toContain('2 subscribers')
    act(() => both.set(false))
    expect(suffix()?.textContent).toContain('1 subscriber')
    expect(suffix()?.textContent).not.toContain('subscribers')
    root.dispose()
  })
})
