/**
 * Scenario: optimistic CRUD over a list query, with entity normalization
 * + reverse-index backprop into a second query.
 *
 * Two queries hold the same Post id at different paths:
 *   - `feed`     : { posts: Post[] }
 *   - `sidebar`  : { recent: Post[] }
 *
 * A `likePost` mutation flips `likes` optimistically via the entities
 * plugin (single write, both queries patched). On server success the
 * value sticks; on server failure the snapshot rolls back to the pre-
 * mutation value in BOTH queries simultaneously.
 *
 * This exercises three packages cooperating: core (query + mutation +
 * snapshot rollback), entities (auto-walk + reverse-index), and the
 * controller (lifecycle + ctx.use).
 */

import {
  createRoot,
  defineController,
  defineQuery,
  type QuerySubscription,
  type Snapshot,
} from '@kontsedal/olas-core'
import { defineEntity, entitiesPlugin } from '@kontsedal/olas-entities'
import { describe, expect, test, vi } from 'vitest'
import { deferred, settle } from './_helpers'

type Post = { id: string; title: string; likes: number }

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) =>
    v !== null &&
    typeof v === 'object' &&
    'id' in v &&
    typeof (v as { id: unknown }).id === 'string' &&
    'title' in v
      ? (v as Post).id
      : null,
})

const seedFeed = (): Post[] => [
  { id: 'p1', title: 'A', likes: 0 },
  { id: 'p2', title: 'B', likes: 0 },
]

describe('integration: optimistic CRUD + entities', () => {
  test('like-post optimistic update patches both queries; commits on server success', async () => {
    const feedQuery = defineQuery({
      queryId: 'int/crud/feed-success',
      key: () => [],
      fetcher: async () => ({ posts: seedFeed() }),
      staleTime: 60_000,
    })
    const sidebarQuery = defineQuery({
      queryId: 'int/crud/sidebar-success',
      key: () => [],
      // Same `p1` referenced via a different query — the reverse index
      // must patch both in one entities.update.
      fetcher: async () => ({ recent: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })

    const plugin = entitiesPlugin([Post])
    const def = defineController((ctx) => {
      const feed = ctx.use(feedQuery, () => [])
      const sidebar = ctx.use(sidebarQuery, () => [])
      const likePost = ctx.mutation<string, { id: string; likes: number }>({
        mutate: async (id: string) => {
          // Pretend server-authoritative count comes back.
          return { id, likes: 1 }
        },
        onMutate: (id) => {
          const before = plugin.get(Post, id)
          if (!before) return
          plugin.update(Post, id, { likes: before.likes + 1 })
        },
        onSuccess: (server) => {
          plugin.update(Post, server.id, { likes: server.likes })
        },
      })
      return { feed, sidebar, likePost }
    })

    type Api = {
      feed: QuerySubscription<{ posts: Post[] }>
      sidebar: QuerySubscription<{ recent: Post[] }>
      likePost: { run: (id: string) => Promise<{ id: string; likes: number }> }
    }
    const root = createRoot(def, { deps: {}, plugins: [plugin] }) as unknown as Api & {
      dispose: () => void
    }

    await settle()
    expect(root.feed.data.peek()?.posts[0]?.likes).toBe(0)
    expect(root.sidebar.data.peek()?.recent[0]?.likes).toBe(0)

    await root.likePost.run('p1')

    // Both queries reflect the patch — single entity.update reached both
    // via the reverse index.
    expect(root.feed.data.peek()?.posts[0]?.likes).toBe(1)
    expect(root.sidebar.data.peek()?.recent[0]?.likes).toBe(1)
    // Sibling unaffected.
    expect(root.feed.data.peek()?.posts[1]?.likes).toBe(0)

    root.dispose()
  })

  test('server failure rolls back the optimistic patch in both queries', async () => {
    const feedQuery = defineQuery({
      queryId: 'int/crud/feed-rollback',
      key: () => [],
      fetcher: async () => ({ posts: seedFeed() }),
      staleTime: 60_000,
    })
    const sidebarQuery = defineQuery({
      queryId: 'int/crud/sidebar-rollback',
      key: () => [],
      fetcher: async () => ({ recent: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })

    const plugin = entitiesPlugin([Post])
    const def = defineController((ctx) => {
      const feed = ctx.use(feedQuery, () => [])
      const sidebar = ctx.use(sidebarQuery, () => [])
      const likePost = ctx.mutation<string, void>({
        mutate: async () => {
          throw new Error('500 — like rejected')
        },
        // Snapshot both query writes so the runner can auto-rollback.
        onMutate: (id) => {
          const feedSnap = feedQuery.setData(() => {
            const current = feedQuery as unknown as never
            void current
            const prev = root.feed.data.peek()
            if (!prev) return { posts: [] as Post[] }
            return {
              posts: prev.posts.map((p) => (p.id === id ? { ...p, likes: p.likes + 1 } : p)),
            }
          })
          const sidebarSnap = sidebarQuery.setData(() => {
            const prev = root.sidebar.data.peek()
            if (!prev) return { recent: [] as Post[] }
            return {
              recent: prev.recent.map((p) => (p.id === id ? { ...p, likes: p.likes + 1 } : p)),
            }
          })
          return {
            rollback: () => {
              feedSnap.rollback()
              sidebarSnap.rollback()
            },
            finalize: () => {
              feedSnap.finalize()
              sidebarSnap.finalize()
            },
          } satisfies Snapshot
        },
        // No explicit onError — the runner auto-rolls back the returned
        // snapshot. Verifies the default-behavior contract from §6.4.
      })
      return { feed, sidebar, likePost }
    })

    type Api = {
      feed: QuerySubscription<{ posts: Post[] }>
      sidebar: QuerySubscription<{ recent: Post[] }>
      likePost: { run: (id: string) => Promise<void> }
    }
    const root = createRoot(def, { deps: {}, plugins: [plugin] }) as unknown as Api & {
      dispose: () => void
    }

    await settle()

    // Mid-flight: the optimistic write IS visible.
    const promise = root.likePost.run('p1').catch((err) => err)
    expect(root.feed.data.peek()?.posts[0]?.likes).toBe(1)
    expect(root.sidebar.data.peek()?.recent[0]?.likes).toBe(1)

    const err = await promise
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/500/)

    // After failure: both queries are rolled back.
    expect(root.feed.data.peek()?.posts[0]?.likes).toBe(0)
    expect(root.sidebar.data.peek()?.recent[0]?.likes).toBe(0)

    root.dispose()
  })

  test('latest-wins racing mutations: superseded run rolls back; winner commits in both queries', async () => {
    const feedQuery = defineQuery({
      queryId: 'int/crud/feed-race',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const sidebarQuery = defineQuery({
      queryId: 'int/crud/sidebar-race',
      key: () => [],
      fetcher: async () => ({ recent: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })

    const plugin = entitiesPlugin([Post])
    const slots = [deferred<number>(), deferred<number>()]
    let i = 0

    const def = defineController((ctx) => {
      const feed = ctx.use(feedQuery, () => [])
      const sidebar = ctx.use(sidebarQuery, () => [])
      const setLikes = ctx.mutation<number, number>({
        mutate: async (target, signal) => {
          const slot = slots[i++]
          if (!slot) throw new Error('out of slots')
          signal.addEventListener('abort', () =>
            slot.reject(new DOMException('Aborted', 'AbortError')),
          )
          return slot.promise.then(() => target)
        },
        onMutate: (target) => {
          // Optimistically push `target` likes via the entities plugin —
          // patches both queries in one shot.
          plugin.update(Post, 'p1', { likes: target })
        },
        concurrency: 'latest-wins',
      })
      return { feed, sidebar, setLikes }
    })

    type Api = {
      feed: QuerySubscription<{ posts: Post[] }>
      sidebar: QuerySubscription<{ recent: Post[] }>
      setLikes: { run: (n: number) => Promise<number> }
    }
    const root = createRoot(def, { deps: {}, plugins: [plugin] }) as unknown as Api & {
      dispose: () => void
    }
    await settle()

    // Kick off slow run #1 (target 10), then slow run #2 (target 20) before
    // #1 resolves.
    const p1 = root.setLikes.run(10).catch(() => 'aborted')
    expect(root.feed.data.peek()?.posts[0]?.likes).toBe(10)
    expect(root.sidebar.data.peek()?.recent[0]?.likes).toBe(10)

    const p2 = root.setLikes.run(20)
    // The optimistic write for run #2 has overwritten run #1.
    expect(root.feed.data.peek()?.posts[0]?.likes).toBe(20)

    // Resolve the winner first; aborted #1 will reject independently.
    slots[1]!.resolve(20)
    expect(await p2).toBe(20)
    await p1

    // Both queries reflect the winner — no flicker back to #1's value.
    expect(root.feed.data.peek()?.posts[0]?.likes).toBe(20)
    expect(root.sidebar.data.peek()?.recent[0]?.likes).toBe(20)

    root.dispose()
  })

  test('disposing the root mid-flight cancels in-flight mutations cleanly', async () => {
    const feedQuery = defineQuery({
      queryId: 'int/crud/dispose-midflight',
      key: () => [],
      fetcher: async () => ({ posts: seedFeed() }),
      staleTime: 60_000,
    })

    const plugin = entitiesPlugin([Post])
    const hold = deferred<void>()

    const def = defineController((ctx) => {
      const feed = ctx.use(feedQuery, () => [])
      const slow = ctx.mutation<void, void>({
        mutate: async (_v, signal) => {
          signal.addEventListener('abort', () =>
            hold.reject(new DOMException('Aborted', 'AbortError')),
          )
          await hold.promise
        },
      })
      return { feed, slow }
    })

    type Api = {
      feed: QuerySubscription<{ posts: Post[] }>
      slow: { run: () => Promise<void> }
    }
    const root = createRoot(def, { deps: {}, plugins: [plugin] }) as unknown as Api & {
      dispose: () => void
    }
    await settle()

    const onSettled = vi.fn()
    void root.slow.run().catch(onSettled)
    root.dispose()
    await settle()
    // After dispose the in-flight mutation was aborted; no unhandled
    // rejection leaks out (the catch ran).
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})
