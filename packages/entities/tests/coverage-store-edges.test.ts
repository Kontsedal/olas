import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  effect,
  queryEngine,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { defineEntity, Entities, type EntityStore, entitiesPlugin } from '../src'

/**
 * Edge coverage for `@kontsedal/olas-entities` that `entities.test.ts` does
 * not reach: the reactive `list()` read, `isCanonical` stub handling,
 * `entries()` value shapes, deep-merge corner cases, reverse-index cleanup
 * after `remove` / gc / a partial re-walk, the missing-engine guard, the
 * slot-bloat warning, and the defensive `setAtPath` bail-outs when a nested
 * entity's recorded path no longer exists in the query.
 *
 * Every query id is prefixed `ent-cov/` — the query registry is
 * process-global, so ids must not collide with the other entities suites.
 */

type Post = { id: string; title: string; likes: number }
type User = { id: string; name: string }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) => (isRecord(v) && typeof v.id === 'string' && 'title' in v ? v.id : null),
})

const User = defineEntity<User>({
  name: 'User',
  idOf: (v) => (isRecord(v) && typeof v.id === 'string' && 'name' in v ? v.id : null),
})

const flush = () => new Promise<void>((r) => queueMicrotask(r))
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush()
}

/** A root with no controller state — the store is driven through its API. */
const bareRoot = (entities: Parameters<typeof entitiesPlugin>[0]['entities']) => {
  const root = createRoot(
    defineController(() => ({})),
    { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities })] },
  )
  return { root, entities: root.inject(Entities) as EntityStore }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('entities.list()', () => {
  test('derives every stored entity, skips empty slots, and re-derives on writes', () => {
    const { root, entities } = bareRoot([Post])
    const list = entities.list(Post)
    expect(list.value).toEqual([])

    entities.upsert(Post, { id: 'p1', title: 'A', likes: 0 })
    // A slot allocated by `signal()` but never written holds `undefined` and
    // must not show up as a list item.
    entities.signal(Post, 'ghost')
    entities.upsert(Post, { id: 'p2', title: 'B', likes: 3 })
    expect(list.value).toEqual([
      { id: 'p1', title: 'A', likes: 0 },
      { id: 'p2', title: 'B', likes: 3 },
    ])

    // List order is the store's (LRU) order, which is not a contract — compare
    // by id.
    const likesById = () => Object.fromEntries(list.value.map((p) => [p.id, p.likes]))
    entities.update(Post, 'p1', { likes: 7 })
    expect(likesById()).toEqual({ p1: 7, p2: 3 })

    entities.remove(Post, 'p2')
    expect(list.value).toEqual([{ id: 'p1', title: 'A', likes: 7 }])

    root.dispose()
  })

  test('filter is applied per item', () => {
    const { root, entities } = bareRoot([Post])
    const popular = entities.list(Post, { filter: (p) => p.likes >= 5 })
    entities.upsert(Post, { id: 'p1', title: 'A', likes: 1 })
    entities.upsert(Post, { id: 'p2', title: 'B', likes: 9 })
    expect(popular.value).toEqual([{ id: 'p2', title: 'B', likes: 9 }])

    entities.update(Post, 'p1', { likes: 5 })
    expect(popular.value.map((p) => p.id).sort()).toEqual(['p1', 'p2'])

    root.dispose()
  })

  test('is reactive: an effect over list() re-runs when a slot is written', () => {
    const { root, entities } = bareRoot([Post])
    const list = entities.list(Post)
    const seen: number[] = []
    const stop = effect(() => {
      seen.push(list.value.length)
    })
    expect(seen).toEqual([0])
    entities.upsert(Post, { id: 'p1', title: 'A', likes: 0 })
    expect(seen.at(-1)).toBe(1)
    entities.upsert(Post, { id: 'p2', title: 'B', likes: 0 })
    expect(seen.at(-1)).toBe(2)
    // Upserts only ever grow the list; no run observed it shrinking.
    expect(seen.every((n, i) => n >= (seen[i - 1] ?? 0))).toBe(true)
    stop()
    const runs = seen.length
    entities.upsert(Post, { id: 'p3', title: 'C', likes: 0 })
    expect(seen).toHaveLength(runs)
    root.dispose()
  })

  test('re-upserting the same reference does not re-derive the list', () => {
    const { root, entities } = bareRoot([Post])
    const p1 = { id: 'p1', title: 'A', likes: 0 }
    entities.upsert(Post, p1)
    const list = entities.list(Post)
    const first = list.value

    entities.upsert(Post, p1)
    // Same slot value (Object.is) → no version bump → the computed returns
    // its cached array.
    expect(list.value).toBe(first)

    entities.upsert(Post, { ...p1 })
    expect(list.value).not.toBe(first)

    root.dispose()
  })

  test('an update whose updater returns the same reference does not re-derive the list', () => {
    const { root, entities } = bareRoot([Post])
    entities.upsert(Post, { id: 'p1', title: 'A', likes: 0 })
    const list = entities.list(Post)
    const first = list.value

    entities.update(Post, 'p1', (prev) => prev)
    expect(list.value).toBe(first)

    entities.update(Post, 'p1', (prev) => ({ ...prev, likes: 1 }))
    expect(list.value).not.toBe(first)
    expect(list.value).toEqual([{ id: 'p1', title: 'A', likes: 1 }])

    root.dispose()
  })

  test('a list handle first read after dispose derives an empty list instead of throwing', () => {
    const { root, entities } = bareRoot([Post])
    entities.upsert(Post, { id: 'p1', title: 'A', likes: 0 })
    const list = entities.list(Post)
    root.dispose()
    expect(list.value).toEqual([])
    // Asking for a new handle is a call into a dead store, which does throw.
    expect(() => entities.list(Post)).toThrow(/disposed/)
  })
})

describe('isCanonical', () => {
  type Author = { id: string; name: string; bio?: string }
  const Author = defineEntity<Author>({
    name: 'Author',
    idOf: (v) => (isRecord(v) && typeof v.id === 'string' ? v.id : null),
    isCanonical: (v) => 'name' in v && 'bio' in v,
  })

  test('stub references never overwrite a canonical record, but still receive backprop', async () => {
    type Mentions = { mentions: Array<{ id: string }>; profile: Author | null }
    const q = defineQuery({
      id: 'ent-cov/canonical',
      key: () => [],
      fetcher: async (): Promise<Mentions> => ({
        // The walk meets the stubs first: two of the same author, plus one
        // of an author the store never sees canonically.
        mentions: [{ id: 'a1' }, { id: 'a1' }, { id: 'a2' }],
        profile: { id: 'a1', name: 'Ann', bio: 'Writes things' },
      }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q, () => []) })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Author] })] },
    )
    const entities = root.inject(Entities)
    await settle()

    const canonical = { id: 'a1', name: 'Ann', bio: 'Writes things' }
    expect(entities.get(Author, 'a1')).toEqual(canonical)
    // A stub alone never materializes a store value.
    expect(entities.get(Author, 'a2')).toBeUndefined()

    // The stub paths are still bound, so a patch reaches them too.
    expect(entities.bindings(Author, 'a1')[0]?.paths).toEqual([
      ['mentions', 0],
      ['mentions', 1],
      ['profile'],
    ])
    expect(entities.bindings(Author, 'a2')[0]?.paths).toEqual([['mentions', 2]])

    entities.update(Author, 'a1', { name: 'Ann B' })
    const data = root.api.q.data.peek()
    const next = { id: 'a1', name: 'Ann B', bio: 'Writes things' }
    expect(data?.profile).toEqual(next)
    expect(data?.mentions).toEqual([next, next, { id: 'a2' }])

    // A later write carrying only a stub keeps the canonical record.
    q.write(() => ({ mentions: [{ id: 'a1' }], profile: null }))
    expect(entities.get(Author, 'a1')).toEqual(next)
    expect(entities.bindings(Author, 'a1')[0]?.paths).toEqual([['mentions', 0]])

    root.dispose()
  })
})

describe('entities.entries() value shapes', () => {
  test('skips empty slots and copies primitive and array entity values', () => {
    // Entity types whose values are not plain objects: a string tag whose id
    // is itself, and a `[id, label]` tuple.
    const Tag = defineEntity<string>({
      name: 'Tag',
      idOf: (v) => (typeof v === 'string' ? v : null),
    })
    type Pair = readonly [string, string]
    const Pair = defineEntity<Pair>({
      name: 'Pair',
      idOf: (v) => (Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null),
    })
    const { root, entities } = bareRoot([Tag, Pair])

    entities.upsert(Tag, 'news')
    entities.signal(Tag, 'unset')
    const pair: Pair = ['k1', 'Label']
    entities.upsert(Pair, pair)

    const tags = entities.entries(Tag)
    expect([...tags.keys()]).toEqual(['news'])
    expect(tags.get('news')).toBe('news')

    const pairs = entities.entries(Pair)
    const snap = pairs.get('k1')
    expect(snap).toEqual(['k1', 'Label'])
    expect(Array.isArray(snap)).toBe(true)
    expect(snap).not.toBe(pair)
    expect(Object.isFrozen(snap)).toBe(true)

    root.dispose()
  })
})

describe('update merge corner cases', () => {
  test("merge: 'deep' treats null-prototype objects as plain and merges into them", () => {
    type Doc = { id: string; title: string; meta: Record<string, unknown> }
    const Doc = defineEntity<Doc>({
      name: 'Doc',
      idOf: (v) => (isRecord(v) && typeof v.id === 'string' ? v.id : null),
    })
    const { root, entities } = bareRoot([Doc])
    const meta = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: 2 })
    entities.upsert(Doc, { id: 'd1', title: 'T', meta })

    const patchMeta = Object.assign(Object.create(null) as Record<string, unknown>, { b: 3 })
    entities.update(Doc, 'd1', { meta: patchMeta }, { merge: 'deep' })

    expect({ ...entities.get(Doc, 'd1')?.meta }).toEqual({ a: 1, b: 3 })
    expect(entities.get(Doc, 'd1')?.title).toBe('T')

    root.dispose()
  })

  test("merge: 'deep' on a class-instance entity replaces it with the patch (non-plain values replace)", () => {
    class Point {
      constructor(
        readonly id: string,
        readonly x: number,
      ) {}
    }
    const PointE = defineEntity<Point>({
      name: 'Point',
      idOf: (v) => (v instanceof Point ? v.id : null),
    })
    const { root, entities } = bareRoot([PointE])
    entities.upsert(PointE, new Point('pt1', 1))

    const patch = { x: 2 }
    entities.update(PointE, 'pt1', patch, { merge: 'deep' })
    // Documented on `update`: non-plain values (class instances) are not
    // merged into — the patch replaces them.
    expect(entities.get(PointE, 'pt1')).toBe(patch)

    root.dispose()
  })
})

describe('remove()', () => {
  test('is a silent no-op for an id the store never held', () => {
    const { root, entities } = bareRoot([Post])
    const list = entities.list(Post)
    const before = list.value
    entities.remove(Post, 'never')
    expect(entities.get(Post, 'never')).toBeUndefined()
    expect(entities.entries(Post).size).toBe(0)
    expect(list.value).toBe(before)
    root.dispose()
  })

  test('a re-walk after remove rebuilds the binding and re-populates the store', async () => {
    const q = defineQuery({
      id: 'ent-cov/remove-rewalk',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q, () => []) })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Post] })] },
    )
    const entities = root.inject(Entities)
    await settle()

    entities.remove(Post, 'p1')
    expect(entities.bindings(Post, 'p1')).toEqual([])

    // The forward index still lists p1 for this entry; the next walk has to
    // tolerate the missing reverse-index entry and rebuild it.
    q.write(() => ({ posts: [{ id: 'p1', title: 'A2', likes: 0 }] }))
    expect(entities.get(Post, 'p1')).toEqual({ id: 'p1', title: 'A2', likes: 0 })
    expect(entities.bindings(Post, 'p1').map((b) => b.paths)).toEqual([[['posts', 0]]])

    root.dispose()
  })
})

describe('reverse-index maintenance', () => {
  test('re-walking one query keeps the bindings another query holds for the same id', async () => {
    const feed = defineQuery({
      id: 'ent-cov/shared-feed',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
    })
    const detail = defineQuery({
      id: 'ent-cov/shared-detail',
      key: () => [],
      fetcher: async () => ({ id: 'p1', title: 'A', likes: 0 }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({
        feed: createQuery(ctx, feed, () => []),
        detail: createQuery(ctx, detail, () => []),
      })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Post] })] },
    )
    const entities = root.inject(Entities)
    await settle()
    expect(entities.bindings(Post, 'p1').map((b) => b.queryId)).toEqual([
      'ent-cov/shared-feed',
      'ent-cov/shared-detail',
    ])

    feed.write(() => ({ posts: [] }))
    expect(entities.bindings(Post, 'p1').map((b) => b.queryId)).toEqual(['ent-cov/shared-detail'])

    entities.update(Post, 'p1', { likes: 4 })
    expect(root.api.detail.data.peek()).toEqual({ id: 'p1', title: 'A', likes: 4 })
    expect(root.api.feed.data.peek()).toEqual({ posts: [] })

    root.dispose()
  })

  test('a gc-removed entry drops its bindings but the entity stays in the store', async () => {
    const q = defineQuery({
      id: 'ent-cov/gc',
      key: () => [],
      fetcher: async () => ({ posts: [{ id: 'p1', title: 'A', likes: 0 }] }),
      staleTime: 60_000,
      gcTime: 0,
    })
    const sub = defineController((ctx) => ({ q: createQuery(ctx, q, () => []) }))
    const app = defineController((ctx) => {
      let handle: { dispose: () => void } | null = null
      return {
        open: () => {
          handle = ctx.attach(sub, undefined)
        },
        close: () => {
          handle?.dispose()
          handle = null
        },
      }
    })
    const root = createRoot(app, {
      queries: queryEngine(),
      deps: {},
      plugins: [entitiesPlugin({ entities: [Post] })],
    })
    const entities = root.inject(Entities)
    const sig = entities.signal(Post, 'p1')

    root.api.open()
    await settle()
    expect(entities.bindings(Post, 'p1')).toHaveLength(1)

    root.api.close()
    // gcTime: 0 → the entry is dropped on release → `onRemove` fires.
    expect(entities.bindings(Post, 'p1')).toEqual([])
    expect(sig.peek()).toEqual({ id: 'p1', title: 'A', likes: 0 })

    // With no bindings, update touches the store only.
    entities.update(Post, 'p1', { likes: 2 })
    expect(sig.peek()?.likes).toBe(2)

    root.dispose()
  })
})

describe('setup guard', () => {
  test('a root without a query engine fails fast with a message naming queryEngine()', () => {
    expect(() =>
      createRoot(
        defineController(() => ({})),
        { deps: {}, plugins: [entitiesPlugin({ entities: [Post] })] },
      ),
    ).toThrow(/needs a query engine/)
  })
})

describe('slot bloat warning', () => {
  test('warns once per partition past 10k unique ids when no maxSlots is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { root, entities } = bareRoot([Post, User])

    for (let i = 0; i < 10_000; i += 1) entities.signal(Post, `p${i}`)
    expect(warn).not.toHaveBeenCalled()

    entities.signal(Post, 'p10000')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/entity "Post" has 10001 unique ids.*maxSlots/)

    // One-shot per partition: further growth stays quiet.
    entities.signal(Post, 'p10001')
    entities.upsert(Post, { id: 'p10002', title: 'X', likes: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    // Other partitions are unaffected.
    expect(entities.entries(User).size).toBe(0)

    root.dispose()
  })
})

describe('nested entity whose recorded path no longer exists', () => {
  // A `Feed` entity that embeds `Post` entities. `update(Feed, …)` writes the
  // query with the plugin's own origin, which the plugin does not re-walk —
  // so the Post bindings recorded by the fetch still point into the old
  // shape. A later `update(Post, …)` must leave the query alone where that
  // path no longer leads anywhere.
  type Feed = {
    id: string
    kind: 'feed'
    posts?: Post[] | null
    pinned?: { post: Post } | null
  }
  const Feed = defineEntity<Feed>({
    name: 'Feed',
    idOf: (v) => (isRecord(v) && v.kind === 'feed' && typeof v.id === 'string' ? v.id : null),
  })

  const p1 = { id: 'p1', title: 'A', likes: 0 }
  const p2 = { id: 'p2', title: 'B', likes: 0 }
  const p3 = { id: 'p3', title: 'C', likes: 0 }

  const mount = async (id: string) => {
    const q = defineQuery({
      id,
      key: () => [],
      fetcher: async () => ({
        feed: { id: 'f1', kind: 'feed' as const, posts: [p1, p2], pinned: { post: p3 } },
      }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q, () => []) })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Feed, Post] })] },
    )
    const entities = root.inject(Entities)
    await settle()
    const data = () => root.api.q.data.peek() as { feed: Feed }
    return { root, entities, data }
  }

  test('an array index past the new end leaves the query unchanged', async () => {
    const { root, entities, data } = await mount('ent-cov/stale-index')
    entities.update(Feed, 'f1', { posts: [p1] })
    entities.update(Post, 'p2', { likes: 9 })
    expect(data().feed.posts).toEqual([p1])
    expect(entities.get(Post, 'p2')?.likes).toBe(9)
    root.dispose()
  })

  test('an array index into a value that is no longer an array leaves the query unchanged', async () => {
    const { root, entities, data } = await mount('ent-cov/stale-not-array')
    entities.update(Feed, 'f1', { posts: null })
    entities.update(Post, 'p1', { likes: 9 })
    expect(data().feed.posts).toBeNull()
    root.dispose()
  })

  test('an object key into a value that is no longer an object leaves the query unchanged', async () => {
    const { root, entities, data } = await mount('ent-cov/stale-not-object')
    entities.update(Feed, 'f1', { pinned: null })
    entities.update(Post, 'p3', { likes: 9 })
    expect(data().feed.pinned).toBeNull()
    root.dispose()
  })

  test('an object key that was removed leaves the query unchanged', async () => {
    const { root, entities, data } = await mount('ent-cov/stale-missing-key')
    entities.update(Feed, 'f1', (prev) => ({ id: prev.id, kind: prev.kind }))
    entities.update(Post, 'p1', { likes: 9 })
    expect(data().feed).toEqual({ id: 'f1', kind: 'feed' })
    root.dispose()
  })
})
