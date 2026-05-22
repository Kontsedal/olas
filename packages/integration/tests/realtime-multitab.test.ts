/**
 * Scenario: a realtime "like-added" event in tab A patches the cache
 * locally AND propagates to tab B via the cross-tab plugin, so both tabs
 * agree without tab B itself receiving the original event.
 *
 * Wire-up:
 *   - Both tabs share an in-memory BroadcastChannel bus (via
 *     `crossTabPlugin({ channelFactory })`).
 *   - Both tabs share a `FakeRealtime` instance — like the real world,
 *     each tab independently subscribes to the same realtime channel.
 *   - Tab A applies the patch via `query.setData`, which fires
 *     `onSetData` on the local plugin → broadcast over the bus → tab B's
 *     plugin applies it as a remote setData.
 *
 * Bonus: the realtime connection state drives a refetch via
 * `onReconnect`, exercising connection-aware UIs.
 */

import {
  createRoot,
  defineController,
  defineQuery,
  type Query,
  type QuerySubscription,
} from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { onReconnect, type RealtimeService, useRealtimePatcher } from '@kontsedal/olas-realtime'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createBusFactory, fakeRealtime, settle } from './_helpers'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}

type Post = { id: string; title: string; likes: number }

type FeedEvent = { type: 'like-added'; postId: string } | { type: 'post-deleted'; postId: string }

const makeFeedQuery = (queryId: string): Query<[], { posts: Post[] }> =>
  defineQuery({
    queryId,
    crossTab: true,
    key: () => [],
    fetcher: async () => ({
      posts: [
        { id: 'p1', title: 'A', likes: 0 },
        { id: 'p2', title: 'B', likes: 0 },
      ],
    }),
    staleTime: 60_000,
  })

describe('integration: realtime + multi-tab', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('like-added event in tab A reaches tab B via the cross-tab bus', async () => {
    // Each "tab" defines its own Query value with the same queryId — the
    // cross-tab plugin uses queryId to route inbound writes; query
    // identity stays per-tab so we don't mask the cross-tab path via
    // a shared __clients set.
    const queryA = makeFeedQuery('int/realtime/feed')
    const queryB = makeFeedQuery('int/realtime/feed')
    const bus = createBusFactory()
    const realtime = fakeRealtime()

    const channelName = 'int/realtime/cache/v1'

    const buildDef = (q: Query<[], { posts: Post[] }>) =>
      defineController((ctx) => {
        const feed = ctx.use(q, () => [])
        useRealtimePatcher<FeedEvent>(ctx, 'feed', {
          'like-added': ({ postId }) => {
            q.setData(() => {
              const prev = feed.data.peek()
              if (!prev) return { posts: [] }
              return {
                posts: prev.posts.map((p) => (p.id === postId ? { ...p, likes: p.likes + 1 } : p)),
              }
            })
          },
          'post-deleted': ({ postId }) => {
            q.setData(() => {
              const prev = feed.data.peek()
              if (!prev) return { posts: [] }
              return { posts: prev.posts.filter((p) => p.id !== postId) }
            })
          },
        })
        return { feed }
      })

    type Api = { feed: QuerySubscription<{ posts: Post[] }> }
    const tabA = createRoot(buildDef(queryA), {
      deps: { realtime },
      plugins: [crossTabPlugin({ channelName, channelFactory: bus.factory })],
    }) as unknown as Api & { dispose: () => void }
    const tabB = createRoot(buildDef(queryB), {
      deps: { realtime },
      plugins: [crossTabPlugin({ channelName, channelFactory: bus.factory })],
    }) as unknown as Api & { dispose: () => void }

    await settle()
    expect(tabA.feed.data.peek()?.posts[0]?.likes).toBe(0)
    expect(tabB.feed.data.peek()?.posts[0]?.likes).toBe(0)

    // Real-world note: BOTH tabs would receive the realtime event from
    // the server. In this test we deliver it only to tabA's subscriber
    // (we'll filter using the fact that emit dispatches to ALL subscribers
    // — so to truly test "tab A's setData reaches tab B", we have to
    // bypass realtime and just call setData on tab A directly).
    //
    // Better: deliver the event only via cross-tab. We do that by
    // emitting on a side-channel that ONLY tab A listens on.
    // Simpler: directly setData on queryA. The realtime patcher coverage
    // lives in the other test below.
    queryA.setData(() => {
      const prev = tabA.feed.data.peek()
      if (!prev) return { posts: [] }
      return {
        posts: prev.posts.map((p) => (p.id === 'p1' ? { ...p, likes: 5 } : p)),
      }
    })
    await settle()

    // Both tabs see the new like-count.
    expect(tabA.feed.data.peek()?.posts[0]?.likes).toBe(5)
    expect(tabB.feed.data.peek()?.posts[0]?.likes).toBe(5)

    tabA.dispose()
    tabB.dispose()
  })

  test('realtime event → patcher → setData → cross-tab broadcast (full pipeline)', async () => {
    // Two tabs, two independent realtime "transports" (simulating each
    // tab having its own WebSocket). Only tab A receives the like-added
    // event; tab B has its own transport handle (no events delivered).
    // Tab B must still see the change via cross-tab.
    const queryA = makeFeedQuery('int/realtime/full-pipeline')
    const queryB = makeFeedQuery('int/realtime/full-pipeline')
    const bus = createBusFactory()
    const rtA = fakeRealtime()
    const rtB = fakeRealtime() // distinct transport — no events delivered

    const channelName = 'int/realtime/full-pipeline/cache'

    const buildDef = (q: Query<[], { posts: Post[] }>) =>
      defineController((ctx) => {
        const feed = ctx.use(q, () => [])
        useRealtimePatcher<FeedEvent>(ctx, 'feed', {
          'like-added': ({ postId }) => {
            q.setData(() => {
              const prev = feed.data.peek()
              if (!prev) return { posts: [] }
              return {
                posts: prev.posts.map((p) => (p.id === postId ? { ...p, likes: p.likes + 1 } : p)),
              }
            })
          },
        })
        return { feed }
      })

    type Api = { feed: QuerySubscription<{ posts: Post[] }> }
    const tabA = createRoot(buildDef(queryA), {
      deps: { realtime: rtA },
      plugins: [crossTabPlugin({ channelName, channelFactory: bus.factory })],
    }) as unknown as Api & { dispose: () => void }
    const tabB = createRoot(buildDef(queryB), {
      deps: { realtime: rtB },
      plugins: [crossTabPlugin({ channelName, channelFactory: bus.factory })],
    }) as unknown as Api & { dispose: () => void }

    await settle()

    // Fire the event only on tab A's transport. Tab B's transport sees
    // nothing.
    rtA.emit('feed', { type: 'like-added', postId: 'p1' })
    await settle()

    // Tab A patched locally + broadcast. Tab B applied as remote setData.
    expect(tabA.feed.data.peek()?.posts[0]?.likes).toBe(1)
    expect(tabB.feed.data.peek()?.posts[0]?.likes).toBe(1)

    // Tab B's realtime transport was never used.
    expect(rtB.subscriberCount('feed')).toBe(1) // it subscribed
    // But nothing was emitted on it — its setData was driven by cross-tab.

    tabA.dispose()
    tabB.dispose()
  })

  test('onReconnect invalidates a query after the connection comes back', async () => {
    const realtime = fakeRealtime()
    let fetches = 0
    const usersQuery = defineQuery({
      queryId: 'int/realtime/onreconnect',
      key: () => [],
      fetcher: async () => {
        fetches += 1
        return { users: [{ id: 'u1', name: 'Alice' }] }
      },
      // Default staleTime so invalidate triggers a refetch.
    })

    const def = defineController((ctx) => {
      const users = ctx.use(usersQuery, () => [])
      onReconnect(ctx, () => {
        usersQuery.invalidate()
      })
      return { users }
    })

    const root = createRoot(def, { deps: { realtime } })
    await settle()
    expect(fetches).toBe(1)

    // Drop to offline — no fetch.
    realtime.setState('offline')
    await settle()
    expect(fetches).toBe(1)

    // Bounce back online — invalidate fires, refetch happens.
    realtime.setState('connected')
    await settle()
    expect(fetches).toBe(2)

    root.dispose()
  })
})
