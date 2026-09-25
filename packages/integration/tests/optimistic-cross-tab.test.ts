/**
 * Scenario: two tabs share one BroadcastChannel bus. Tab B also runs the
 * query-cache persister and the entities plugin, the two plugins that keep
 * server truth. Tab A makes an optimistic write.
 *
 * Cross-tab used to apply A's guess in B as a canonical write, so B's
 * persister stored the guess and B's stale clock restarted. B now mirrors it
 * as a guess of its own, which A's rollback or commit settles. The persister
 * keeps what the entry's server truth is, and entities follows what B shows.
 */

import {
  bindQuery,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  type Query,
  queryEngine,
} from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { defineEntity, Entities, entitiesPlugin } from '@kontsedal/olas-entities'
import { persistQueryCachePlugin } from '@kontsedal/olas-persist'
import { describe, expect, test } from 'vitest'
import { createBusFactory, type MemoryAdapter, memoryAdapter } from './_helpers'

type Post = { id: string; title: string; likes: number }

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) =>
    v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
      ? v.id
      : null,
})

const postQuery = (id: string): Query<[], Post> =>
  defineQuery({
    id,
    key: () => [],
    fetcher: async () => ({ id: 'p1', title: 'Hello', likes: 0 }),
    staleTime: 60_000,
    meta: { crossTab: true, persist: true },
  })

const storedPost = (storage: MemoryAdapter): unknown =>
  (
    JSON.parse(storage.store.get('olas/query-cache') ?? '{"entries":[]}') as {
      entries: Array<{ data: unknown }>
    }
  ).entries[0]?.data

function tabs(id: string) {
  const bus = createBusFactory()
  const storage = memoryAdapter()
  const make = (withStorage: boolean) => {
    const q = postQuery(id)
    return createRoot(
      defineController((ctx) => ({ post: createQuery(ctx, q), posts: bindQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [
          crossTabPlugin({ channelName: 'optimistic', channelFactory: bus.factory }),
          ...(withStorage
            ? [
                persistQueryCachePlugin({ storage, throttleMs: 0 }),
                entitiesPlugin({ entities: [Post] }),
              ]
            : []),
        ],
      },
    )
  }
  return { a: make(false), b: make(true), storage }
}

describe("cross-tab + persist + entities — a peer's optimistic write", () => {
  test('a failed peer guess is never stored, and the store drops it on the rollback', async () => {
    const { a, b, storage } = tabs('it-opt/rollback')
    await a.waitForIdle()
    await b.waitForIdle()
    const entities = b.inject(Entities)

    const like = a.api.posts.setData((p) => ({ ...p!, likes: 1 }))
    await b.waitForIdle()
    expect(b.api.post.data.peek()).toEqual({ id: 'p1', title: 'Hello', likes: 1 })
    expect(entities.get(Post, 'p1')?.likes).toBe(1) // B's views follow the guess
    expect(storedPost(storage)).toEqual({ id: 'p1', title: 'Hello', likes: 0 })

    like.rollback()
    await b.waitForIdle()
    expect(b.api.post.data.peek()).toEqual({ id: 'p1', title: 'Hello', likes: 0 })
    expect(entities.get(Post, 'p1')?.likes).toBe(0)
    expect(storedPost(storage)).toEqual({ id: 'p1', title: 'Hello', likes: 0 })
    a.dispose()
    b.dispose()
  })

  test("a peer's commit is stored in this tab, and the store holds it", async () => {
    const { a, b, storage } = tabs('it-opt/commit')
    await a.waitForIdle()
    await b.waitForIdle()
    const entities = b.inject(Entities)

    const like = a.api.posts.setData((p) => ({ ...p!, likes: 1 }))
    await b.waitForIdle()
    expect(storedPost(storage)).toEqual({ id: 'p1', title: 'Hello', likes: 0 })

    like.finalize()
    await b.waitForIdle()
    expect(b.api.post.data.peek()).toEqual({ id: 'p1', title: 'Hello', likes: 1 })
    expect(storedPost(storage)).toEqual({ id: 'p1', title: 'Hello', likes: 1 })
    expect(entities.get(Post, 'p1')?.likes).toBe(1)
    expect(b.api.post.hasPendingMutations.peek()).toBe(false)
    a.dispose()
    b.dispose()
  })
})
