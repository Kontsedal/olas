/**
 * `cache:subscribed` / `cache:unsubscribed` carry each subscription's controller path,
 * and `root.debug.queryEntries()` counts the subscriptions on each entry. Also: a
 * plugin's `host.queries.invalidate` sends the `cache:invalidated` an app's does.
 */
import { describe, expect, test } from 'vitest'
import { createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import type { DebugEvent } from '../src/devtools'
import { definePlugin } from '../src/plugin/host'
import type { PluginHost } from '../src/plugin/types'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

type SubscriberEvent = Extract<DebugEvent, { type: 'cache:subscribed' | 'cache:unsubscribed' }>

const subscriberEvents = (events: DebugEvent[]): Array<[string, unknown[], string[]]> =>
  events
    .filter(
      (e): e is SubscriberEvent => e.type === 'cache:subscribed' || e.type === 'cache:unsubscribed',
    )
    .map((e) => [e.type === 'cache:subscribed' ? '+' : '-', [...e.queryKey], [...e.subscriberPath]])

describe('subscriber events', () => {
  test('each subscription reports its path on bind, key change and dispose', () => {
    const q = defineQuery({
      id: 'dt-subs/regular',
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string) => id,
    })
    const id = signal('a')
    const panel = defineController((ctx) => ({ s: createQuery(ctx, q, () => [id.value]) }), {
      name: 'panel',
    })
    const events: DebugEvent[] = []
    const root = createRoot(
      defineController((ctx) => ({
        left: ctx.child(panel, undefined),
        right: ctx.child(panel, undefined),
      })),
      { queries: queryEngine(), deps: {} },
    )
    root.debug.subscribe((e) => events.push(e))
    id.set('b')
    root.dispose()

    const [first] = events.filter((e) => e.type === 'cache:unsubscribed')
    expect(first).toMatchObject({ queryId: 'dt-subs/regular' })
    expect(subscriberEvents(events)).toEqual([
      ['-', ['user', 'a'], ['root', 'panel[0]']],
      ['+', ['user', 'b'], ['root', 'panel[0]']],
      ['-', ['user', 'a'], ['root', 'panel[1]']],
      ['+', ['user', 'b'], ['root', 'panel[1]']],
      ['-', ['user', 'b'], ['root', 'panel[1]']],
      ['-', ['user', 'b'], ['root', 'panel[0]']],
    ])
  })

  test('the snapshot counts subscriptions and leaves out a prefetch', async () => {
    let answer: (v: string) => void = () => {}
    const q = defineQuery({
      id: 'dt-subs/count',
      key: (id: string) => [id],
      fetcher: (_ctx, id: string) =>
        id === 'slow' ? new Promise<string>((r) => (answer = r)) : Promise.resolve(id),
    })
    const view = defineController((ctx) => ({ s: createQuery(ctx, q, () => ['k']) }))
    const root = createRoot(
      defineController((ctx) => ({ a: ctx.child(view, undefined), b: ctx.child(view, undefined) })),
      { queries: queryEngine(), deps: {} },
    )
    const prefetched = root.bindQuery(q).prefetch('slow')
    const counts = Object.fromEntries(
      root.debug.queryEntries().map((e) => [String(e.key[0]), e.subscribers]),
    )
    expect(counts).toEqual({ k: 2, slow: 0 })
    answer('done')
    await prefetched
    root.dispose()
  })

  test('suspend and resume release and re-acquire, and an infinite query reports too', () => {
    const feed = defineInfiniteQuery({
      id: 'dt-subs/infinite',
      key: () => ['feed'],
      fetcher: async () => [1],
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const events: DebugEvent[] = []
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    root.debug.subscribe((e) => events.push(e))
    expect(root.debug.queryEntries()[0]?.subscribers).toBe(1)
    root.suspend()
    expect(root.debug.queryEntries()[0]?.subscribers).toBe(0)
    root.resume()
    root.dispose()
    expect(subscriberEvents(events)).toEqual([
      ['-', ['feed'], ['root']],
      ['+', ['feed'], ['root']],
      ['-', ['feed'], ['root']],
    ])
  })
})

describe('host.queries.invalidate', () => {
  test('sends cache:invalidated, as the app-side invalidate does', async () => {
    const q = defineQuery({
      id: 'dt-subs/host-invalidate',
      key: () => ['k'],
      fetcher: async () => 1,
    })
    let host: PluginHost | undefined
    const events: DebugEvent[] = []
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [
          definePlugin({
            name: 'invalidator',
            setup: (h) => {
              host = h
            },
          }),
        ],
      },
    )
    await root.waitForIdle()
    root.debug.subscribe((e) => events.push(e))
    await host?.queries?.invalidate('dt-subs/host-invalidate', ['k'])
    expect(events.filter((e) => e.type === 'cache:invalidated')).toEqual([
      expect.objectContaining({ queryId: 'dt-subs/host-invalidate', queryKey: ['k'] }),
    ])
    root.dispose()
  })
})
