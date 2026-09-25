import {
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  effect,
  type OlasPlugin,
  type Query,
  queryEngine,
  type WriteEvent,
} from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import { defineEntity, ENTITIES_PLUGIN_NAME, Entities, entitiesPlugin } from '../src'

/**
 * End-to-end coverage for `@kontsedal/olas-entities`. Each test mounts a
 * fresh root with its own plugin instance; queries declare a unique
 * `queryId` per test (the core query registry is process-global, so
 * sharing queryIds across tests would risk routing crosstalk).
 *
 * The fake fetcher pattern: a vi.fn returning a controlled value, called
 * exactly once per `ctx.use` (staleTime is set high so focus/reconnect
 * refetch noise doesn't leak into assertions).
 */

type Post = { id: string; title: string; likes: number }
type User = { id: string; name: string }

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) =>
    v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
      ? v.id
      : null,
})

const User = defineEntity<User>({
  name: 'User',
  idOf: (v) =>
    v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'name' in v
      ? v.id
      : null,
})

const flush = () => new Promise<void>((r) => queueMicrotask(r))
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush()
}

describe('defineEntity', () => {
  test('returns a branded handle with the configured name + idOf', () => {
    expect((Post as unknown as Record<symbol, unknown>)[Symbol.for('olas.brand')]).toBe('entity')
    expect(Post.name).toBe('Post')
    expect(Post.idOf({ id: 'p1', title: 'X', likes: 0 })).toBe('p1')
    expect(Post.idOf({ id: 'u1', name: 'Alice' })).toBe(null)
    expect(Post.idOf(null)).toBe(null)
    expect(Post.idOf(42)).toBe(null)
  })
})

describe('entitiesPlugin', () => {
  test('throws on duplicate entity names', () => {
    const Dup = defineEntity<Post>({ name: 'Post', idOf: () => null })
    expect(() => entitiesPlugin({ entities: [Post, Dup] })).toThrow(/duplicate entity name "Post"/)
  })

  test('auto-walks fetch results and populates the store', async () => {
    const feedQuery: Query<[], { posts: Post[]; pinned: Post }> = defineQuery({
      id: 'ent-test/1',
      key: () => [],
      fetcher: async () => ({
        posts: [
          { id: 'p1', title: 'A', likes: 0 },
          { id: 'p2', title: 'B', likes: 0 },
        ],
        pinned: { id: 'p3', title: 'Pinned', likes: 5 },
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post, User] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    await settle()

    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'A', likes: 0 })
    expect(entities.get(Post, 'p2')).toEqual({ id: 'p2', title: 'B', likes: 0 })
    expect(entities.get(Post, 'p3')).toEqual({ id: 'p3', title: 'Pinned', likes: 5 })

    root.dispose()
  })

  test('per-id signal fires on observation', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/2',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)

    const sig = entities.signal(Post, 'p1')
    expect(sig.peek()).toBeUndefined()

    const seen: Array<Post | undefined> = []
    const unsub = sig.subscribe((v) => seen.push(v))
    await settle()

    expect(sig.peek()).toEqual({ id: 'p1', title: 'A', likes: 0 })
    // subscribe(handler) fires synchronously with the initial value
    // (`undefined`), then with the fetched value.
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toEqual({ id: 'p1', title: 'A', likes: 0 })

    unsub()
    root.dispose()
  })

  test('explicit upsert populates the store for non-query sources', () => {
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)

    expect(entities.get(Post, 'p1')).toBeUndefined()
    entities.upsert(Post, { id: 'p1', title: 'Direct', likes: 0 })
    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'Direct', likes: 0 })

    // upsert with a non-entity value (idOf returns null) is a silent no-op
    // — we can't store something without an id.
    entities.upsert(Post, { wrong: 'shape' } as unknown as Post)
    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'Direct', likes: 0 })

    root.dispose()
  })

  test('update patches the store + a single query holding the entity', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/3',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    entities.update(Post, 'p1', { likes: 1 })

    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'A', likes: 1 })
    expect(root.api.feed.data.peek()).toEqual({ posts: [{ id: 'p1', title: 'A', likes: 1 }] })

    root.dispose()
  })

  test('update backpropagates to multiple queries holding the same entity', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/4/feed',
      key: () => [],
      fetcher: async () => ({
        posts: [
          { id: 'p1', title: 'A', likes: 0 },
          { id: 'p2', title: 'B', likes: 0 },
        ],
      }),
      staleTime: 60_000,
    })
    const profileQuery = defineQuery({
      id: 'ent-test/4/profile',
      key: () => [],
      fetcher: async () => ({
        user: { id: 'u1', name: 'Alice' },
        // Same Post id `p1` lives in the profile's `latestPosts` too.
        latestPosts: [{ id: 'p1', title: 'A', likes: 0 }],
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post, User] })
    const def = defineController((ctx) => ({
      feed: createQuery(ctx, feedQuery, () => []),
      profile: createQuery(ctx, profileQuery, () => []),
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    entities.update(Post, 'p1', { title: 'A!', likes: 42 })

    // Both queries see the same patch on the shared entity.
    expect(root.api.feed.data.peek()?.posts[0]).toEqual({ id: 'p1', title: 'A!', likes: 42 })
    expect(root.api.profile.data.peek()?.latestPosts[0]).toEqual({
      id: 'p1',
      title: 'A!',
      likes: 42,
    })
    // Sibling entity unaffected.
    expect(root.api.feed.data.peek()?.posts[1]).toEqual({ id: 'p2', title: 'B', likes: 0 })
    // User in the other query unaffected.
    expect(root.api.profile.data.peek()?.user).toEqual({ id: 'u1', name: 'Alice' })

    root.dispose()
  })

  test('update reaches an entity at multiple paths in the same query', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/5',
      key: () => [],
      fetcher: async () => ({
        posts: [
          { id: 'p1', title: 'A', likes: 0 },
          { id: 'p2', title: 'B', likes: 0 },
        ],
        // Same Post id (p1) ALSO appears as `pinned` — backprop should
        // patch both paths in one setData write.
        pinned: { id: 'p1', title: 'A', likes: 0 },
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    entities.update(Post, 'p1', { likes: 99 })

    const after = root.api.feed.data.peek()
    expect(after?.posts[0]).toEqual({ id: 'p1', title: 'A', likes: 99 })
    expect(after?.pinned).toEqual({ id: 'p1', title: 'A', likes: 99 })
    // Same reference at both paths after the patch: the backprop replaced
    // every node that is p1 with the one `next` value.
    expect(after?.posts[0]).toBe(after?.pinned)

    root.dispose()
  })

  test('update is a no-op when the entity is not in the store', () => {
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)

    entities.update(Post, 'never-seen', { likes: 999 })
    expect(entities.get(Post, 'never-seen')).toBeUndefined()

    root.dispose()
  })

  test('update on a missing entity does not allocate a slot or trip LRU eviction', () => {
    // Repro: with `maxSlots` set, a no-op update used to allocate an empty
    // slot via `getSlot` and LRU-touch it — under cap pressure that could
    // evict a real entity. After the fix the missing-entity update is a true
    // no-op: no slot allocated, no eviction triggered.
    const SmallEntity = defineEntity<{ id: string; n: number }>({
      name: 'SmallEntity',
      idOf: (v) =>
        v != null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'n' in v
          ? v.id
          : null,
      maxSlots: 2,
    })
    const plugin = entitiesPlugin({ entities: [SmallEntity] })
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)

    entities.upsert(SmallEntity, { id: 'a', n: 1 })
    entities.upsert(SmallEntity, { id: 'b', n: 2 })
    // The no-op update on a never-seen id must not push an empty slot — if
    // it did, the partition would hit cap=2 and evict `a` to make room.
    entities.update(SmallEntity, 'never-seen', { n: 99 })
    expect(entities.get(SmallEntity, 'a')).toEqual({ id: 'a', n: 1 })
    expect(entities.get(SmallEntity, 'b')).toEqual({ id: 'b', n: 2 })
    expect(entities.get(SmallEntity, 'never-seen')).toBeUndefined()

    root.dispose()
  })

  test('subscribers re-render exactly once per update across N affected queries', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/6/feed',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const sidebarQuery = defineQuery({
      id: 'ent-test/6/sidebar',
      key: () => [],
      fetcher: async () => ({ recent: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({
      feed: createQuery(ctx, feedQuery, () => []),
      sidebar: createQuery(ctx, sidebarQuery, () => []),
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    const feedFires = vi.fn()
    const sidebarFires = vi.fn()
    const sig = entities.signal(Post, 'p1')
    const sigFires = vi.fn()
    // subscribe fires synchronously with the current value (`once`),
    // so reset the call counts after attaching.
    root.api.feed.data.subscribe(feedFires)
    root.api.sidebar.data.subscribe(sidebarFires)
    sig.subscribe(sigFires)
    feedFires.mockClear()
    sidebarFires.mockClear()
    sigFires.mockClear()

    entities.update(Post, 'p1', { likes: 7 })

    expect(feedFires).toHaveBeenCalledTimes(1)
    expect(sidebarFires).toHaveBeenCalledTimes(1)
    expect(sigFires).toHaveBeenCalledTimes(1)

    root.dispose()
  })

  test('one plugin value gives each root its own store', () => {
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController(() => ({}))
    const root1 = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const root2 = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const a = root1.inject(Entities)
    const b = root2.inject(Entities)
    expect(a).not.toBe(b)
    a.upsert(Post, { id: 'p1', title: 'only in root1', likes: 0 })
    expect(a.get(Post, 'p1')?.title).toBe('only in root1')
    expect(b.get(Post, 'p1')).toBeUndefined()
    root1.dispose()
    root2.dispose()
  })

  test('reverse index drops bindings when an entity disappears from a query', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/8',
      key: () => [],
      fetcher: async () => ({
        posts: [
          { id: 'p1', title: 'A', likes: 0 },
          { id: 'p2', title: 'B', likes: 0 },
        ],
      }),
      staleTime: 60_000,
    })
    // Records every backprop write, so the test can see that none was made.
    const backprops: WriteEvent[] = []
    const spy: OlasPlugin = {
      name: 'spy',
      setup: () => ({
        onWrite: (e) => {
          if (e.origin === ENTITIES_PLUGIN_NAME) backprops.push(e)
        },
      }),
    }
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [entitiesPlugin({ entities: [Post] }), spy],
    })
    const entities = root.inject(Entities)
    await settle()
    // The fetch bound both posts, so there is a binding to drop.
    expect(entities.bindings(Post, 'p1').map((b) => b.paths)).toEqual([[['posts', 0]]])
    expect(entities.bindings(Post, 'p2').map((b) => b.paths)).toEqual([[['posts', 1]]])

    feedQuery.setData(() => ({ posts: [{ id: 'p2', title: 'B', likes: 0 }] }))

    // p1 left the feed, so it has no binding. p2's binding is rebuilt at its
    // new index, not added to the old one.
    expect(entities.bindings(Post, 'p1')).toEqual([])
    expect(entities.bindings(Post, 'p2').map((b) => b.paths)).toEqual([[['posts', 0]]])

    // With no binding, an update of p1 patches the store and writes no query.
    const feedBefore = root.api.feed.data.peek()
    entities.update(Post, 'p1', { likes: 999 })
    expect(backprops).toEqual([])
    expect(root.api.feed.data.peek()).toBe(feedBefore)
    expect(entities.get(Post, 'p1')?.likes).toBe(999)

    root.dispose()
  })

  test('signal handle is stable across calls (same id → same signal)', () => {
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)

    const s1 = entities.signal(Post, 'p1')
    const s2 = entities.signal(Post, 'p1')
    expect(s1).toBe(s2)

    const s3 = entities.signal(Post, 'p2')
    expect(s3).not.toBe(s1)

    root.dispose()
  })

  test('invalidate removes the entity from the store without touching queries', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/9',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    expect(entities.get(Post, 'p1')).toBeDefined()
    entities.remove(Post, 'p1')
    expect(entities.get(Post, 'p1')).toBeUndefined()
    // Query data untouched — invalidate is store-only.
    expect(root.api.feed.data.peek()?.posts[0]).toEqual({ id: 'p1', title: 'A', likes: 0 })

    root.dispose()
  })

  test('cycle in query data does not stack-overflow the walker', async () => {
    type Cyclic = { id: string; title: string; likes: number; self?: unknown }
    const cyclicQuery: Query<[], Cyclic> = defineQuery({
      id: 'ent-test/cycle',
      key: () => [],
      fetcher: async () => {
        const post: Cyclic = { id: 'p1', title: 'A', likes: 0 }
        post.self = post
        return post
      },
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ q: createQuery(ctx, cyclicQuery, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    await settle()

    expect(entities.get(Post, 'p1')).toMatchObject({ id: 'p1', title: 'A', likes: 0 })
    root.dispose()
  })

  test('non-entity objects with an `id` field are NOT classified', async () => {
    type NotPost = { id: string; someField: number }
    const q: Query<[], { stuff: NotPost[] }> = defineQuery({
      id: 'ent-test/disambig',
      key: () => [],
      // Has `id` strings but no `title`/`name`, so neither idOf claims them.
      fetcher: async () => ({ stuff: [{ id: 'x1', someField: 1 }] }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post, User] })
    const def = defineController((ctx) => ({ q: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    await settle()

    expect(entities.get(Post, 'x1')).toBeUndefined()
    expect(entities.get(User, 'x1')).toBeUndefined()
    root.dispose()
  })

  // -- Bug-fix regressions (review pass) -----------------------------------

  test('shared-reference DAG: one Post object at two paths gets both bindings', async () => {
    // The PREVIOUS walker used a "ever visited" WeakSet, which skipped the
    // second occurrence and silently lost the binding — entity.update would
    // then patch only one path. This test pins the stack-based detection.
    const sharedQuery = defineQuery({
      id: 'ent-test/dag',
      key: () => [],
      fetcher: async () => {
        const post: Post = { id: 'p1', title: 'A', likes: 0 }
        // Same reference at two paths — NOT two literals with the same id.
        return { posts: [post, { id: 'p2', title: 'B', likes: 0 }], pinned: post }
      },
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, sharedQuery, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    // Backprop must reach BOTH paths.
    entities.update(Post, 'p1', { likes: 42 })
    const after = root.api.feed.data.peek()
    expect(after?.posts[0]).toEqual({ id: 'p1', title: 'A', likes: 42 })
    expect(after?.pinned).toEqual({ id: 'p1', title: 'A', likes: 42 })

    // Devtools introspection confirms both paths in the reverse index.
    const bindings = entities.bindings(Post, 'p1')
    expect(bindings).toHaveLength(1)
    const paths = bindings[0]?.paths.map((p) => p.join('.'))
    expect(paths).toEqual(expect.arrayContaining(['posts.0', 'pinned']))

    root.dispose()
  })

  test('true cycle: a self-referencing Post still terminates and records once', async () => {
    type Cyclic = Post & { self?: unknown }
    const cyclicQuery: Query<[], Cyclic> = defineQuery({
      id: 'ent-test/cycle-strict',
      key: () => [],
      fetcher: async () => {
        const post: Cyclic = { id: 'p1', title: 'A', likes: 0 }
        post.self = post // direct self-loop
        return post
      },
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ q: createQuery(ctx, cyclicQuery, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    await settle()

    // The cycle short-circuits at the second `.self` re-entry. We still
    // recorded the entity itself (one binding, root path `[]`).
    const bindings = entities.bindings(Post, 'p1')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.paths).toEqual([[]])
    root.dispose()
  })

  test('a chain of diamonds is walked and patched in linear time, and stays shared', async () => {
    // Each level points at the next through two keys, so the Post at the
    // bottom is at the end of 2^DEPTH paths. A walk that follows every path
    // calls idOf about 2^(DEPTH + 1) times; one that descends into each object
    // once calls it about twice per level.
    const DEPTH = 16
    let calls = 0
    const Counted = defineEntity<Post>({
      name: 'Post',
      idOf: (v) => {
        calls += 1
        return Post.idOf(v)
      },
    })
    type Level = { a: Level | Post; b: Level | Post }
    const diamonds = (): Level => {
      let node: Level | Post = { id: 'leaf', title: 'L', likes: 0 }
      for (let i = 0; i < DEPTH; i += 1) node = { a: node, b: node }
      return node as Level
    }
    const q: Query<[], Level> = defineQuery({
      id: 'ent-test/diamond-chain',
      key: () => [],
      fetcher: async () => diamonds(),
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ q: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [entitiesPlugin({ entities: [Counted] })],
    })
    const entities = root.inject(Entities)
    await settle()

    expect(entities.get(Counted, 'leaf')).toEqual({ id: 'leaf', title: 'L', likes: 0 })
    // One call per reference: the root, then two per level.
    expect(calls).toBeLessThanOrEqual(2 * DEPTH + 1)
    // The leaf is bound once per reference into it, from the first path to
    // its parent: `a` all the way down, then `a` or `b`.
    const paths = entities.bindings(Counted, 'leaf')[0]?.paths.map((p) => p.join('.'))
    const parent = Array.from({ length: DEPTH - 1 }, () => 'a').join('.')
    expect(paths).toEqual([`${parent}.a`, `${parent}.b`])

    calls = 0
    entities.update(Counted, 'leaf', { likes: 1 })
    // The patch finds the leaf once per object, and the re-walk once per
    // reference, so the update is linear too.
    expect(calls).toBeLessThanOrEqual(3 * DEPTH + 2)
    let node: Level | Post = root.api.q.data.peek() as Level
    for (let i = 0; i < DEPTH; i += 1) {
      const level = node as Level
      // The rebuilt chain keeps one object per level, shared by both keys.
      expect(level.a).toBe(level.b)
      node = level.a
    }
    expect(node).toEqual({ id: 'leaf', title: 'L', likes: 1 })

    root.dispose()
  })

  test('calling signal / get / upsert / update / invalidate / entries / bindings on an unregistered entity throws', () => {
    const Unrelated = defineEntity<{ id: string; foo: string }>({
      name: 'Unrelated',
      idOf: (v) => (v as { id?: string }).id ?? null,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)

    const expectErr = /entity "Unrelated" was not registered/
    expect(() => entities.signal(Unrelated, 'x')).toThrow(expectErr)
    expect(() => entities.get(Unrelated, 'x')).toThrow(expectErr)
    expect(() => entities.upsert(Unrelated, { id: 'x', foo: 'y' })).toThrow(expectErr)
    expect(() => entities.update(Unrelated, 'x', { foo: 'y' })).toThrow(expectErr)
    expect(() => entities.remove(Unrelated, 'x')).toThrow(expectErr)
    expect(() => entities.entries(Unrelated)).toThrow(expectErr)
    expect(() => entities.bindings(Unrelated, 'x')).toThrow(expectErr)

    root.dispose()
  })

  test('calling into the store after dispose says it was disposed, not unregistered', () => {
    // `dispose()` clears the same `store` that the registration check
    // probes, so a post-dispose call used to report "was not registered"
    // and send the reader hunting for a missing entitiesPlugin({ entities: [...] }) entry
    // that was there all along.
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    entities.upsert(Post, { id: 'p1', title: 'Live', likes: 0 })
    root.dispose()

    const expectErr = /the store was disposed with its owning root/
    expect(() => entities.signal(Post, 'p1')).toThrow(expectErr)
    expect(() => entities.get(Post, 'p1')).toThrow(expectErr)
    expect(() => entities.upsert(Post, { id: 'p2', title: 'Late', likes: 0 })).toThrow(expectErr)
    expect(() => entities.update(Post, 'p1', { title: 'Late' })).toThrow(expectErr)
    expect(() => entities.remove(Post, 'p1')).toThrow(expectErr)
    expect(() => entities.entries(Post)).toThrow(expectErr)
    expect(() => entities.bindings(Post, 'p1')).toThrow(expectErr)
    // And it does NOT claim the entity was never registered.
    expect(() => entities.get(Post, 'p1')).not.toThrow(/was not registered/)
  })

  test('keyArgs containing a Date is handled correctly (uses stableHash)', async () => {
    // The OLD bindingKey used JSON.stringify — same Date instance hashed
    // ok-ish, but two equivalent Dates produced different keys. stableHash
    // canonicalizes Dates to ISO strings, so equivalent timestamps share
    // an index slot AND match the QueryClient's own entry hash.
    const t = new Date('2026-05-20T00:00:00.000Z')
    type WithDate = { day: Date; posts: Post[] }
    const dailyQuery: Query<[Date], WithDate> = defineQuery({
      id: 'ent-test/date-keys',
      key: (day: Date) => [day],
      fetcher: async (_ctx, day: Date) => ({
        day,
        posts: [{ id: 'p1', title: 'A', likes: 0 }],
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ daily: createQuery(ctx, dailyQuery, () => [t]) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    entities.update(Post, 'p1', { likes: 9 })
    expect(root.api.daily.data.peek()?.posts[0]).toEqual({ id: 'p1', title: 'A', likes: 9 })

    root.dispose()
  })

  test('update accepts an updater function as well as a Partial patch', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/updater',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    entities.update(Post, 'p1', (prev) => ({ ...prev, likes: prev.likes + 5 }))
    expect(entities.get(Post, 'p1')?.likes).toBe(5)
    expect(root.api.feed.data.peek()?.posts[0]?.likes).toBe(5)

    entities.update(Post, 'p1', (prev) => ({ ...prev, likes: prev.likes + 10 }))
    expect(entities.get(Post, 'p1')?.likes).toBe(15)
    expect(root.api.feed.data.peek()?.posts[0]?.likes).toBe(15)

    root.dispose()
  })

  test('update on a missing entity warns in dev and is a no-op', () => {
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    entities.update(Post, 'never-seen', { likes: 999 })
    expect(entities.get(Post, 'never-seen')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/entities\.update.*never-seen.*no-op/s)

    warn.mockRestore()
    root.dispose()
  })

  test('entries() returns a Map snapshot of the partition; mutating it does not affect the store', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/entries',
      key: () => [],
      fetcher: async () => ({
        posts: [
          { id: 'p1', title: 'A', likes: 0 },
          { id: 'p2', title: 'B', likes: 0 },
        ],
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    await settle()

    const snap = entities.entries(Post)
    expect(snap.size).toBe(2)
    expect(snap.get('p1')).toEqual({ id: 'p1', title: 'A', likes: 0 })
    expect(snap.get('p2')).toEqual({ id: 'p2', title: 'B', likes: 0 })

    // Mutating the returned Map MUST NOT affect the live store.
    ;(snap as Map<string, Post>).delete('p1')
    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'A', likes: 0 })

    // A second call returns a fresh snapshot.
    const snap2 = entities.entries(Post)
    expect(snap2).not.toBe(snap)
    expect(snap2.size).toBe(2)

    root.dispose()
  })

  test('SSR: hydrated data populates the entity store (no fetch needed)', () => {
    // Reproduces the SSR-first scenario. The server has already fetched and
    // dehydrated; the client mounts with `hydrate: state` and no fetcher
    // runs. Before the fix, `Entry.applySuccess` never fired for hydrated
    // entries → the entities plugin never saw the data → `entities.signal`
    // returned undefined on first paint.
    const feedQuery = defineQuery<[], { posts: Post[]; pinned: Post }>({
      id: 'ent-test/hydrate',
      key: () => [],
      // Mark as if the test ever ran the fetcher we'd notice.
      fetcher: async () => {
        throw new Error('fetcher must not run when data is hydrated')
      },
      staleTime: 60_000,
    })

    // Build a dehydrated state, then mount a fresh root with it.
    const hydrated = {
      version: 1 as const,
      entries: [
        {
          id: 'ent-test/hydrate',
          key: [] as readonly unknown[],
          data: {
            posts: [
              { id: 'p1', title: 'A', likes: 0 },
              { id: 'p2', title: 'B', likes: 0 },
            ],
            pinned: { id: 'p1', title: 'A', likes: 0 },
          },
          lastUpdatedAt: Date.now(),
        },
      ],
    }

    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
      hydrate: hydrated,
    })
    const entities = root.inject(Entities)

    // First paint: hydrated data is already there and the entity store sees it.
    expect(root.api.feed.data.peek()?.posts[0]).toEqual({ id: 'p1', title: 'A', likes: 0 })
    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'A', likes: 0 })
    expect(entities.get(Post, 'p2')).toEqual({ id: 'p2', title: 'B', likes: 0 })

    // Backprop works: entities.update reaches the hydrated query immediately.
    entities.update(Post, 'p1', { likes: 7 })
    expect(root.api.feed.data.peek()?.posts[0]?.likes).toBe(7)
    expect(root.api.feed.data.peek()?.pinned?.likes).toBe(7)

    root.dispose()
  })

  test('entries() values are shallow-cloned + frozen — snapshot mutation does NOT corrupt the live store', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/frozen-entries',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    await settle()

    const snap = entities.entries(Post)
    const p1 = snap.get('p1') as Post

    // Snapshot is NOT === to the live store value (it's a shallow clone).
    expect(p1).not.toBe(entities.get(Post, 'p1'))
    expect(p1).toEqual(entities.get(Post, 'p1'))

    // And it's frozen — strict-mode throw, non-strict silent-no-op. Either
    // way, the live store value is not corrupted.
    expect(() => {
      ;(p1 as { likes: number }).likes = 999
    }).toThrow()
    expect(entities.get(Post, 'p1')?.likes).toBe(0)

    root.dispose()
  })

  test('bindings() returns deep-cloned binding info for a single id', async () => {
    const feedQuery = defineQuery({
      id: 'ent-test/bindings',
      key: () => [],
      fetcher: async () => ({
        posts: [
          { id: 'p1', title: 'A', likes: 0 },
          { id: 'p1', title: 'A', likes: 0 }, // duplicate by id in the same query
        ],
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Post] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feedQuery, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    await settle()

    const bindings = entities.bindings(Post, 'p1')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.queryId).toBe('ent-test/bindings')
    expect(bindings[0]?.keyArgs).toEqual([])
    expect(bindings[0]?.paths).toEqual([
      ['posts', 0],
      ['posts', 1],
    ])

    // The returned binding is deep-frozen — the outer object, the paths
    // array, AND each path array. Any mutation throws in strict mode (which
    // vitest runs in). The live reverse index is therefore impossible to
    // corrupt through this API.
    type MutableBinding = {
      queryId: string
      keyArgs: Array<unknown>
      paths: Array<Array<string | number>>
    }
    expect(() => {
      ;(bindings[0] as unknown as MutableBinding).paths[0]?.push('garbage')
    }).toThrow()
    expect(() => {
      ;(bindings[0] as unknown as MutableBinding).queryId = 'tampered'
    }).toThrow()
    expect(() => {
      ;(bindings[0] as unknown as MutableBinding).keyArgs.push('garbage')
    }).toThrow()
    const bindings2 = entities.bindings(Post, 'p1')
    expect(bindings2[0]?.paths).toEqual([
      ['posts', 0],
      ['posts', 1],
    ])
    expect(bindings2[0]?.queryId).toBe('ent-test/bindings')

    // Unknown ids return an empty array (not undefined).
    expect(entities.bindings(Post, 'never-seen')).toEqual([])

    root.dispose()
  })

  test('update with merge: deep recursively merges nested objects', async () => {
    type NestedPost = {
      id: string
      title: string
      author: { name: string; profile: { bio: string; verified: boolean } }
      tags: string[]
    }
    const NestedPost = defineEntity<NestedPost>({
      name: 'NestedPost',
      idOf: (v) =>
        v !== null &&
        typeof v === 'object' &&
        'id' in v &&
        typeof v.id === 'string' &&
        'author' in v
          ? v.id
          : null,
    })
    const q = defineQuery({
      id: 'ent-test/deep-merge',
      key: () => [],
      fetcher: async (): Promise<{ post: NestedPost }> => ({
        post: {
          id: 'p1',
          title: 'A',
          author: { name: 'Ada', profile: { bio: 'hi', verified: false } },
          tags: ['x', 'y'],
        },
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [NestedPost] })
    const def = defineController((ctx) => ({ q: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    // Patch only `author.profile.verified` — the rest of `author.profile`
    // and `author.name` should survive.
    entities.update(
      NestedPost,
      'p1',
      { author: { profile: { verified: true } } } as Partial<NestedPost>,
      { merge: 'deep' },
    )

    const next = entities.get(NestedPost, 'p1')
    expect(next).toEqual({
      id: 'p1',
      title: 'A',
      author: { name: 'Ada', profile: { bio: 'hi', verified: true } },
      tags: ['x', 'y'],
    })
    // Same in the query.
    expect(root.api.q.data.peek()?.post.author.profile).toEqual({ bio: 'hi', verified: true })

    root.dispose()
  })

  test('update with merge: deep replaces arrays wholesale (no array-merge)', async () => {
    type WithTags = { id: string; title: string; tags: string[] }
    const WithTags = defineEntity<WithTags>({
      name: 'WithTagsDeep',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'tags' in v
          ? v.id
          : null,
    })
    const q = defineQuery({
      id: 'ent-test/deep-array',
      key: () => [],
      fetcher: async (): Promise<{ p: WithTags }> => ({
        p: { id: 'p1', title: 'A', tags: ['x', 'y', 'z'] },
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [WithTags] })
    const def = defineController((ctx) => ({ q: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    entities.update(WithTags, 'p1', { tags: ['only'] }, { merge: 'deep' })
    expect(entities.get(WithTags, 'p1')?.tags).toEqual(['only'])

    root.dispose()
  })

  test('maxSlots evicts orphan slots in LRU order on overflow', async () => {
    type Item = { id: string; title: string }
    const Item = defineEntity<Item>({
      name: 'LRUItem',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
          ? v.id
          : null,
      maxSlots: 2,
    })
    const plugin = entitiesPlugin({ entities: [Item] })
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)

    // Three orphan upserts (no query holds them). With maxSlots: 2, the
    // first should be evicted on the third insert.
    entities.upsert(Item, { id: 'i1', title: 'A' })
    entities.upsert(Item, { id: 'i2', title: 'B' })
    entities.upsert(Item, { id: 'i3', title: 'C' })

    expect(entities.get(Item, 'i1')).toBeUndefined()
    expect(entities.get(Item, 'i2')).toEqual({ id: 'i2', title: 'B' })
    expect(entities.get(Item, 'i3')).toEqual({ id: 'i3', title: 'C' })

    root.dispose()
  })

  test('maxSlots never evicts bound entities (active query subscribers)', async () => {
    type Item = { id: string; title: string }
    const Item = defineEntity<Item>({
      name: 'LRUItemBound',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
          ? v.id
          : null,
      maxSlots: 1,
    })
    const q = defineQuery({
      id: 'ent-test/lru-bound',
      key: () => [],
      fetcher: async (): Promise<{ items: Item[] }> => ({
        items: [
          { id: 'b1', title: 'A' },
          { id: 'b2', title: 'B' },
        ],
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Item] })
    const def = defineController((ctx) => ({ q: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    // Both bound — neither can be evicted, cap is exceeded silently.
    expect(entities.get(Item, 'b1')).toEqual({ id: 'b1', title: 'A' })
    expect(entities.get(Item, 'b2')).toEqual({ id: 'b2', title: 'B' })

    // Adding a third (orphan) upsert: the orphan is evictable, but it's
    // the *newest*. There are no orphans to evict among older slots, so
    // the cap is exceeded silently.
    entities.upsert(Item, { id: 'b3', title: 'C' })
    expect(entities.get(Item, 'b1')).toEqual({ id: 'b1', title: 'A' })
    expect(entities.get(Item, 'b2')).toEqual({ id: 'b2', title: 'B' })
    expect(entities.get(Item, 'b3')).toEqual({ id: 'b3', title: 'C' })

    root.dispose()
  })

  test('maxSlots: touching a slot promotes it (LRU order)', async () => {
    type Item = { id: string; title: string }
    const Item = defineEntity<Item>({
      name: 'LRUItemPromote',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
          ? v.id
          : null,
      maxSlots: 2,
    })
    const plugin = entitiesPlugin({ entities: [Item] })
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)

    entities.upsert(Item, { id: 'a', title: 'A' })
    entities.upsert(Item, { id: 'b', title: 'B' })
    // Touch `a` via `signal(...)` (which IS an LRU touch — `get` is a
    // pure peek and intentionally side-effect-free).
    void entities.signal(Item, 'a')
    // Insert a third — `b` is now LRU and should be evicted.
    entities.upsert(Item, { id: 'c', title: 'C' })

    expect(entities.get(Item, 'a')).toEqual({ id: 'a', title: 'A' })
    expect(entities.get(Item, 'b')).toBeUndefined()
    expect(entities.get(Item, 'c')).toEqual({ id: 'c', title: 'C' })

    root.dispose()
  })

  test('maxSlots never evicts a slot a subscriber holds, even with no query binding it', async () => {
    type Item = { id: string; title: string }
    const Item = defineEntity<Item>({
      name: 'LRUItemWatched',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
          ? v.id
          : null,
      maxSlots: 2,
    })
    const detailQuery = defineQuery({
      id: 'ent-test/lru-watched',
      key: () => [],
      fetcher: async (): Promise<Item> => ({ id: 'p1', title: 'Detail' }),
      staleTime: 60_000,
      gcTime: 0,
    })
    const plugin = entitiesPlugin({ entities: [Item] })
    const def = defineController((ctx) => ({
      open: () =>
        ctx.attach(
          defineController((c) => ({ q: createQuery(c, detailQuery, () => []) })),
          undefined,
        ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, plugins: [plugin] })
    const entities = root.inject(Entities)
    const child = root.api.open()
    await settle()

    // A detail view subscribes to p1; then its query is collected.
    const handle = entities.signal(Item, 'p1')
    const seen: Array<string | undefined> = []
    const off = handle.subscribe((v) => seen.push(v?.title))
    child.dispose() // gcTime 0: the query and its binding are gone
    expect(entities.bindings(Item, 'p1')).toEqual([])

    // Two more ids overflow the cap. p1 is the oldest orphan, but it is watched.
    entities.upsert(Item, { id: 'p2', title: 'B' })
    entities.upsert(Item, { id: 'p3', title: 'C' })
    expect(entities.get(Item, 'p1')).toEqual({ id: 'p1', title: 'Detail' })
    expect(entities.get(Item, 'p2')).toBeUndefined()
    expect(seen).toEqual(['Detail'])

    // Once the view lets go, p1 can be evicted, and its handle comes back to
    // life when p1 returns.
    off()
    entities.upsert(Item, { id: 'p4', title: 'D' })
    expect(entities.get(Item, 'p1')).toBeUndefined()
    const read: Array<string | undefined> = []
    const stop = effect(() => {
      read.push(handle.value?.title)
    })
    entities.upsert(Item, { id: 'p1', title: 'Back' })
    expect(read).toEqual([undefined, 'Back'])
    expect(entities.signal(Item, 'p1')).toBe(handle)
    stop()
    root.dispose()
  })

  test('a subscription holds its slot after the caller drops the handle and it is collected', async () => {
    // Real collection: `--expose-gc` set at runtime, and `gc` read from a fresh
    // context. The package's types leave Node out, hence the cast.
    const { process } = globalThis as unknown as {
      process: { getBuiltinModule(id: string): any }
    }
    process.getBuiltinModule('node:v8').setFlagsFromString('--expose-gc')
    const gc = process.getBuiltinModule('node:vm').runInNewContext('gc') as () => void
    const tick = () => new Promise((r) => setTimeout(r, 0))
    // A task between collections, so `deref` no longer keeps the target alive.
    const collect = async (ref: WeakRef<object>) => {
      for (let i = 0; i < 10 && ref.deref() !== undefined; i += 1) {
        await tick()
        gc()
      }
      await tick() // the registry's cleanup runs in a later task
    }
    type Item = { id: string; title: string }
    const Item = defineEntity<Item>({
      name: 'LRUItemCollected',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
          ? v.id
          : null,
      maxSlots: 2,
    })
    const root = createRoot(
      defineController(() => ({})),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Item] })] },
    )
    const entities = root.inject(Entities)
    entities.upsert(Item, { id: 'p1', title: 'A' })

    // Two callers keep only their unsubscribes and let the handle go.
    const seen: Array<string | undefined> = []
    const { off, offChanges, ref } = (() => {
      const handle = entities.signal(Item, 'p1')
      return {
        off: handle.subscribe((v) => seen.push(v?.title)),
        offChanges: handle.subscribeChanges(() => {}),
        ref: new WeakRef(handle),
      }
    })()
    await collect(ref)

    entities.upsert(Item, { id: 'p2', title: 'B' })
    entities.upsert(Item, { id: 'p3', title: 'C' })
    expect(entities.get(Item, 'p1')).toEqual({ id: 'p1', title: 'A' })
    expect(seen).toEqual(['A'])

    // One subscription still holds the handle.
    offChanges()
    await collect(ref)
    expect(ref.deref()).toBeDefined()
    // With none open, the handle is collectable again: the store pins nothing.
    off()
    await collect(ref)
    expect(ref.deref()).toBeUndefined()
    root.dispose()
  })

  test('walks infinite-query pages and backpropagates through setEntryData', async () => {
    type FeedItem = { id: string; title: string; likes: number }
    const FeedItem = defineEntity<FeedItem>({
      name: 'InfFeedItem',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'title' in v
          ? v.id
          : null,
    })

    const pages: FeedItem[][] = [
      [
        { id: 'p1', title: 'A', likes: 0 },
        { id: 'p2', title: 'B', likes: 0 },
      ],
      [
        { id: 'p3', title: 'C', likes: 0 },
        { id: 'p4', title: 'D', likes: 0 },
      ],
    ]

    const feed = defineInfiniteQuery<[], number, FeedItem[]>({
      id: 'ent-test/infinite-feed',
      key: () => [],
      fetcher: async ({ pageParam }): Promise<FeedItem[]> => pages[pageParam] ?? [],
      initialPageParam: 0,
      getNextPageParam: (_lastPage, allPages) =>
        allPages.length < pages.length ? allPages.length : null,
      staleTime: 60_000,
    })

    const plugin = entitiesPlugin({ entities: [FeedItem] })
    const def = defineController((ctx) => ({ feed: createQuery(ctx, feed, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()
    // Load the second page so the walker has multiple pages to traverse.
    await root.api.feed.fetchNextPage()
    await settle()

    // Entities from both pages should be normalized into the store.
    expect(entities.get(FeedItem, 'p1')).toEqual({ id: 'p1', title: 'A', likes: 0 })
    expect(entities.get(FeedItem, 'p3')).toEqual({ id: 'p3', title: 'C', likes: 0 })

    // Bindings point at the right (pageIdx, inPagePath) coordinates.
    const bindings = entities.bindings(FeedItem, 'p3')
    expect(bindings.length).toBe(1)
    expect(bindings[0]?.paths).toEqual([[1, 0]])

    // Backprop through update — reaches the page-internal slot.
    entities.update(FeedItem, 'p3', { likes: 7 })
    expect(entities.get(FeedItem, 'p3')).toEqual({ id: 'p3', title: 'C', likes: 7 })
    expect(root.api.feed.pages.peek()[1]?.[0]).toEqual({ id: 'p3', title: 'C', likes: 7 })
    // The backprop write keeps the pages' params, so a dehydrate or cross-tab
    // relay after it still carries the right cursors.
    const entry = root.dehydrate().entries.find((e) => e.id === 'ent-test/infinite-feed')
    expect(entry?.pageParams).toEqual([0, 1])

    root.dispose()
  })

  test('update default is still shallow — nested patch replaces the subtree', async () => {
    type Nested = { id: string; meta: { a: number; b: number } }
    const Nested = defineEntity<Nested>({
      name: 'NestedShallow',
      idOf: (v) =>
        v !== null && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'meta' in v
          ? v.id
          : null,
    })
    const q = defineQuery({
      id: 'ent-test/shallow-default',
      key: () => [],
      fetcher: async (): Promise<{ n: Nested }> => ({
        n: { id: 'n1', meta: { a: 1, b: 2 } },
      }),
      staleTime: 60_000,
    })
    const plugin = entitiesPlugin({ entities: [Nested] })
    const def = defineController((ctx) => ({ q: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    const entities = root.inject(Entities)
    await settle()

    // No options → shallow: meta is replaced wholesale.
    entities.update(Nested, 'n1', { meta: { a: 9 } } as Partial<Nested>)
    expect(entities.get(Nested, 'n1')?.meta).toEqual({ a: 9 })

    root.dispose()
  })
})

describe('update — nested entities the patch brings in', () => {
  type Article = { id: string; title: string; author: User }

  test('a new nested entity is normalized, and the binding follows the patch', async () => {
    const q = defineQuery({
      id: 'ent-test/nested-update',
      key: () => [],
      fetcher: async (): Promise<Article> => ({
        id: 'p1',
        title: 'T',
        author: { id: 'u1', name: 'Ada' },
      }),
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ article: createQuery(ctx, q) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [entitiesPlugin({ entities: [Post, User] })],
    })
    const entities = root.inject(Entities)
    await root.waitForIdle()

    entities.update(Post, 'p1', { author: { id: 'u2', name: 'Bob' } } as Partial<Post>)
    expect(entities.get(User, 'u2')).toEqual({ id: 'u2', name: 'Bob' })
    // u1 no longer appears in the query, so updating it must not reach it.
    entities.update(User, 'u1', { name: 'Ada Lovelace' })
    expect((root.api.article.data.value as Article).author).toEqual({ id: 'u2', name: 'Bob' })
    // And an update to the new author reaches the query.
    entities.update(User, 'u2', { name: 'Bobby' })
    expect((root.api.article.data.value as Article).author.name).toBe('Bobby')
    root.dispose()
  })

  test('an entity no query holds still absorbs the nested entities of its patch', () => {
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [entitiesPlugin({ entities: [Post, User] })],
      },
    )
    const entities = root.inject(Entities)
    entities.upsert(Post, { id: 'p9', title: 'Solo', likes: 0 })
    entities.update(Post, 'p9', { author: { id: 'u9', name: 'Cy' } } as Partial<Post>)
    expect(entities.get(User, 'u9')).toEqual({ id: 'u9', name: 'Cy' })
    root.dispose()
  })
})
