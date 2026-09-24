/**
 * Scenario: two tabs, each with the entities plugin and the cross-tab plugin,
 * sharing one in-memory BroadcastChannel bus.
 *
 * An `entities.update(...)` backprop is a write stamped with the entities
 * plugin's origin, and cross-tab mirrors only the app's own writes unless its
 * `origins` lists another. So:
 *   - by default a patch stays in the tab that made it;
 *   - with `origins: [ENTITIES_PLUGIN_NAME]` it crosses, and the peer's
 *     entities plugin walks the mirrored write into its own store;
 *   - an app write that crosses is walked by the peer's entities plugin, so
 *     the peer's store follows it with no entities traffic at all.
 *
 * The last test measures what opting in costs when every tab makes the same
 * update itself, as it does for a realtime push each tab receives.
 */

import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  type Query,
  queryEngine,
} from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import {
  defineEntity,
  ENTITIES_PLUGIN_NAME,
  Entities,
  type EntityStore,
  entitiesPlugin,
} from '@kontsedal/olas-entities'
import { describe, expect, test } from 'vitest'
import { createBusFactory, settle } from './_helpers'

type Post = { id: string; title: string; likes: number }
type Feed = { posts: Post[] }

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) =>
    v !== null && typeof v === 'object' && typeof (v as Post).id === 'string' && 'title' in v
      ? (v as Post).id
      : null,
})

let counter = 0

/** One query value per tab, sharing only the id, as two real tabs would. */
const feedQuery = (id: string): Query<[], Feed> =>
  defineQuery({
    id,
    meta: { crossTab: true },
    key: () => [],
    fetcher: async () => ({
      posts: [
        { id: 'p1', title: 'A', likes: 0 },
        { id: 'p2', title: 'B', likes: 0 },
      ],
    }),
    staleTime: 60_000,
  })

/** Two tabs on one bus. `origins` goes to both tabs' cross-tab plugins. */
async function twoTabs(origins?: readonly string[]) {
  const id = `int/xtab-entities/${++counter}`
  const channelName = `${id}/cache`
  const bus = createBusFactory()
  const mount = (query: Query<[], Feed>) => {
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, query, () => []) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [
          entitiesPlugin({ entities: [Post] }),
          crossTabPlugin({
            channelName,
            channelFactory: bus.factory,
            ...(origins ? { origins } : {}),
          }),
        ],
      },
    )
    return {
      root,
      query,
      entities: root.inject(Entities) as EntityStore,
      feed: () => root.api.feed.data.peek(),
    }
  }
  const a = mount(feedQuery(id))
  const b = mount(feedQuery(id))
  await settle()
  expect(a.entities.get(Post, 'p1')?.likes).toBe(0)
  expect(b.entities.get(Post, 'p1')?.likes).toBe(0)
  return {
    a,
    b,
    posts: () => bus.postCount(channelName),
    dispose: () => {
      a.root.dispose()
      b.root.dispose()
    },
  }
}

describe('integration: cross-tab with entities', () => {
  test('by default an entities.update patch stays in the tab that made it', async () => {
    const t = await twoTabs()
    t.a.entities.update(Post, 'p1', { likes: 5 })
    await settle()

    expect(t.a.feed()?.posts[0]?.likes).toBe(5)
    expect(t.posts()).toBe(0)
    expect(t.b.feed()?.posts[0]?.likes).toBe(0)
    expect(t.b.entities.get(Post, 'p1')?.likes).toBe(0)
    t.dispose()
  })

  test('with origins: [ENTITIES_PLUGIN_NAME] the patch crosses, and the peer walks it into its store', async () => {
    const t = await twoTabs([ENTITIES_PLUGIN_NAME])
    const seen: Array<number | undefined> = []
    const off = t.b.entities.signal(Post, 'p1').subscribe((p) => {
      seen.push(p?.likes)
    })

    t.a.entities.update(Post, 'p1', { likes: 5 })
    await settle()

    // One message: the backprop into A's feed.
    expect(t.posts()).toBe(1)
    expect(t.b.feed()?.posts[0]).toEqual({ id: 'p1', title: 'A', likes: 5 })
    expect(t.b.entities.get(Post, 'p1')?.likes).toBe(5)
    expect(seen).toEqual([0, 5])
    // The peer applied it with cross-tab's origin, so nothing came back.
    expect(t.a.feed()?.posts[0]?.likes).toBe(5)
    off()
    t.dispose()
  })

  test("an app write that crosses is walked by the peer's entities plugin", async () => {
    const t = await twoTabs()
    const seen: Array<number | undefined> = []
    const off = t.b.entities.signal(Post, 'p1').subscribe((p) => {
      seen.push(p?.likes)
    })

    t.a.query.write(() => ({
      posts: [
        { id: 'p1', title: 'A', likes: 3 },
        { id: 'p2', title: 'B', likes: 0 },
      ],
    }))
    await settle()

    expect(t.posts()).toBe(1)
    expect(t.b.entities.get(Post, 'p1')?.likes).toBe(3)
    expect(seen).toEqual([0, 3])
    // B's reverse index follows the mirrored data, so B's own update reaches it.
    t.b.entities.update(Post, 'p1', { likes: 4 })
    expect(t.b.feed()?.posts[0]?.likes).toBe(4)
    off()
    t.dispose()
  })

  test('opting in doubles the traffic when every tab makes the same update itself', async () => {
    // A realtime push reaches every tab, and each folds it in on its own.
    // Returns how many times each tab's feed changed.
    const push = async (t: Awaited<ReturnType<typeof twoTabs>>) => {
      const changes = { a: 0, b: 0 }
      const offA = t.a.root.api.feed.data.subscribe(() => {
        changes.a += 1
      })
      const offB = t.b.root.api.feed.data.subscribe(() => {
        changes.b += 1
      })
      // `subscribe` calls back once with the current value.
      changes.a = 0
      changes.b = 0
      t.a.entities.update(Post, 'p1', { likes: 7 })
      t.b.entities.update(Post, 'p1', { likes: 7 })
      await settle()
      offA()
      offB()
      return changes
    }

    const quiet = await twoTabs()
    expect(await push(quiet)).toEqual({ a: 1, b: 1 })
    expect(quiet.posts()).toBe(0)
    expect(quiet.a.feed()?.posts[0]?.likes).toBe(7)
    expect(quiet.b.feed()?.posts[0]?.likes).toBe(7)
    quiet.dispose()

    // Opted in, each tab also sends its patch, and each receives the other's:
    // a message per tab, and a second, redundant write in every tab.
    const loud = await twoTabs([ENTITIES_PLUGIN_NAME])
    expect(await push(loud)).toEqual({ a: 2, b: 2 })
    expect(loud.posts()).toBe(2)
    expect(loud.a.feed()?.posts[0]?.likes).toBe(7)
    expect(loud.b.feed()?.posts[0]?.likes).toBe(7)
    loud.dispose()
  })
})
