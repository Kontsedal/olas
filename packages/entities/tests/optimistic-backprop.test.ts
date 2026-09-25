import {
  bindQuery,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { defineEntity, Entities, entitiesPlugin } from '../src'

/**
 * `entities.update` against optimistic writes. The store walks every write,
 * guesses included, so an `update` made while a like is pending starts from
 * the guess. The backprop used to write that whole record into every query
 * that holds the entity, as a canonical write: into queries with no guess of
 * their own, and into the baselines a rollback restores. A failed like then
 * stayed everywhere. The backprop now patches each query's own copy of the
 * entity, so the engine re-runs it on each baseline (SPEC §6.4).
 */

type Post = { id: string; title: string; likes: number }

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) =>
    v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
      ? v.id
      : null,
})

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function feedAndDetail(prefix: string) {
  const feed = defineQuery({
    id: `${prefix}/feed`,
    key: () => [],
    fetcher: async (): Promise<Post[]> => [{ id: 'p1', title: 'Hello', likes: 0 }],
    staleTime: 60_000,
  })
  const detail = defineQuery({
    id: `${prefix}/detail`,
    key: () => [],
    fetcher: async (): Promise<Post> => ({ id: 'p1', title: 'Hello', likes: 0 }),
    staleTime: 60_000,
  })
  const root = createRoot(
    defineController((ctx) => ({
      feed: createQuery(ctx, feed),
      detail: createQuery(ctx, detail),
      feeds: bindQuery(ctx, feed),
    })),
    { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Post] })] },
  )
  return { root, entities: root.inject(Entities) }
}

describe('entities.update while an optimistic write is live', () => {
  test('a failed guess does not survive in any query, or in the store', async () => {
    const { root, entities } = feedAndDetail('ent-opt/rollback')
    await settle()

    // A like, optimistically, on the feed.
    const like = root.api.feeds.setData((posts = []) =>
      posts.map((p) => (p.id === 'p1' ? { ...p, likes: p.likes + 1 } : p)),
    )
    expect(entities.get(Post, 'p1')?.likes).toBe(1) // the store shows the guess

    // A push renames the post while the like is pending.
    entities.update(Post, 'p1', { title: 'Renamed' })
    expect(root.api.feed.data.peek()).toEqual([{ id: 'p1', title: 'Renamed', likes: 1 }])
    // The detail never held the guess, and the rename does not bring it in.
    expect(root.api.detail.data.peek()).toEqual({ id: 'p1', title: 'Renamed', likes: 0 })

    // The like fails.
    like.rollback()
    expect(root.api.feed.data.peek()).toEqual([{ id: 'p1', title: 'Renamed', likes: 0 }])
    expect(root.api.detail.data.peek()).toEqual({ id: 'p1', title: 'Renamed', likes: 0 })
    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'Renamed', likes: 0 })
    root.dispose()
  })

  test('a committed guess stays, with the patch', async () => {
    const { root, entities } = feedAndDetail('ent-opt/commit')
    await settle()

    const like = root.api.feeds.setData((posts = []) =>
      posts.map((p) => (p.id === 'p1' ? { ...p, likes: p.likes + 1 } : p)),
    )
    entities.update(Post, 'p1', { title: 'Renamed' })
    like.finalize()
    expect(root.api.feed.data.peek()).toEqual([{ id: 'p1', title: 'Renamed', likes: 1 }])
    // The commit is walked as canonical: the store holds the committed like.
    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'Renamed', likes: 1 })
    root.dispose()
  })

  test('an updater patch runs on each copy of the entity, and on each baseline', async () => {
    const { root, entities } = feedAndDetail('ent-opt/updater')
    await settle()

    const like = root.api.feeds.setData((posts = []) =>
      posts.map((p) => (p.id === 'p1' ? { ...p, likes: p.likes + 1 } : p)),
    )
    // A server push: someone else liked it too.
    entities.update(Post, 'p1', (p) => ({ ...p, likes: p.likes + 10 }))
    expect(root.api.feed.data.peek()).toEqual([{ id: 'p1', title: 'Hello', likes: 11 }])
    expect(root.api.detail.data.peek()).toEqual({ id: 'p1', title: 'Hello', likes: 10 })

    like.rollback()
    expect(root.api.feed.data.peek()).toEqual([{ id: 'p1', title: 'Hello', likes: 10 }])
    expect(entities.get(Post, 'p1')?.likes).toBe(10)
    root.dispose()
  })
})

describe('entities.update keeps prototypes', () => {
  // A fetcher that returns a class instance, such as a page wrapper with
  // methods. The backprop rebuilt every object on the path to the entity with
  // `{ ...record }`, which dropped the prototype.
  class Page {
    constructor(
      readonly items: Post[],
      readonly next: string | null,
    ) {}
    hasMore(): boolean {
      return this.next !== null
    }
  }

  test('a class instance on the path to the entity keeps its class', async () => {
    const q = defineQuery({
      id: 'ent-proto/page',
      key: () => [],
      fetcher: async () => new Page([{ id: 'p1', title: 'Hello', likes: 0 }], 'cursor-2'),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Post] })] },
    )
    const entities = root.inject(Entities)
    await settle()

    entities.update(Post, 'p1', { title: 'Renamed' })
    const data = root.api.q.data.peek()
    expect(data).toBeInstanceOf(Page)
    expect(data?.hasMore()).toBe(true)
    expect(data?.items[0]?.title).toBe('Renamed')
    root.dispose()
  })

  test('a null-prototype object stays one, and an entity class keeps its class', async () => {
    class PostModel {
      constructor(
        readonly id: string,
        readonly title: string,
        readonly likes: number,
      ) {}
      shout(): string {
        return this.title.toUpperCase()
      }
    }
    const holder = Object.assign(Object.create(null) as Record<string, unknown>, {
      post: new PostModel('p1', 'Hello', 0),
    })
    const q = defineQuery({
      id: 'ent-proto/null',
      key: () => [],
      fetcher: async () => holder,
      staleTime: 60_000,
      structuralShare: false,
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Post] })] },
    )
    const entities = root.inject(Entities)
    await settle()

    entities.update(Post, 'p1', { title: 'Renamed' } as Partial<Post>)
    const data = root.api.q.data.peek() as Record<string, unknown>
    expect(Object.getPrototypeOf(data)).toBeNull()
    const post = data.post as PostModel
    expect(post).toBeInstanceOf(PostModel)
    expect(post.shout()).toBe('RENAMED')
    expect(entities.get(Post, 'p1')).toBeInstanceOf(PostModel)
    root.dispose()
  })
})
