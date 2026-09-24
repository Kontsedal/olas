/**
 * The entities plugin's devtools lane: every `update` reports its backprop
 * fan-out through `host.debug`, which core delivers as a `plugin:event` named
 * after the plugin. Development builds only; vitest runs with `__DEV__` on.
 */
import {
  createQuery,
  createRoot,
  type DebugEvent,
  defineController,
  defineQuery,
  type OlasPlugin,
  queryEngine,
} from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import {
  defineEntity,
  ENTITIES_PLUGIN_NAME,
  Entities,
  type EntityStore,
  entitiesPlugin,
} from '../src'

type Post = { id: string; title: string; likes: number }

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) =>
    v !== null && typeof v === 'object' && typeof (v as Post).id === 'string' && 'title' in v
      ? (v as Post).id
      : null,
})

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/** The payloads on one plugin's lane, in order. */
const lane = (events: DebugEvent[], plugin: string): unknown[] =>
  events.flatMap((e) => (e.type === 'plugin:event' && e.plugin === plugin ? [e.payload] : []))

describe('entities devtools lane', () => {
  test('an update reports the entity, and the entries and queries it reached', async () => {
    const p1 = { id: 'p1', title: 'A', likes: 0 }
    const feed = defineQuery({
      id: 'ent-lane/feed',
      key: () => [],
      fetcher: async () => ({ posts: [p1] }),
      staleTime: 60_000,
    })
    const detail = defineQuery({
      id: 'ent-lane/detail',
      key: (id: string) => [id],
      fetcher: async () => p1,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({
        feed: createQuery(ctx, feed, () => []),
        detail: createQuery(ctx, detail, () => ['p1']),
      })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [Post] })] },
    )
    const events: DebugEvent[] = []
    const off = root.debug.subscribe((e) => {
      events.push(e)
    })
    await settle()
    // Walks report nothing: only an update does.
    expect(lane(events, ENTITIES_PLUGIN_NAME)).toEqual([])

    const entities = root.inject(Entities)
    entities.update(Post, 'p1', { likes: 1 })
    entities.upsert(Post, { id: 'p9', title: 'orphan', likes: 0 })
    entities.update(Post, 'p9', { likes: 2 })

    expect(lane(events, ENTITIES_PLUGIN_NAME)).toEqual([
      {
        kind: 'update',
        entity: 'Post',
        id: 'p1',
        entries: 2,
        stale: 0,
        queries: ['ent-lane/feed', 'ent-lane/detail'],
      },
      { kind: 'update', entity: 'Post', id: 'p9', entries: 0, stale: 0, queries: [] },
    ])
    off()
    root.dispose()
  })

  test('an entry the reverse index listed but that no longer holds the entity counts as stale', async () => {
    const p1 = { id: 'p1', title: 'A', likes: 0 }
    const feed = defineQuery({
      id: 'ent-lane/stale',
      key: () => [],
      fetcher: async (): Promise<{ posts: Post[] }> => ({ posts: [p1] }),
      staleTime: 60_000,
    })
    let entities: EntityStore | undefined
    // Installed before entities: it patches p1 while entities still binds it
    // into the feed, which the app has just emptied.
    const reactor: OlasPlugin = {
      name: 'reactor',
      setup: () => ({
        onWrite: (e) => {
          if (e.origin === undefined && e.source === 'write') entities?.update(Post, 'p1', {})
        },
      }),
    }
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, feed, () => []) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [reactor, entitiesPlugin({ entities: [Post] })],
      },
    )
    entities = root.inject(Entities)
    await settle()
    const events: DebugEvent[] = []
    const off = root.debug.subscribe((e) => {
      events.push(e)
    })

    feed.write(() => ({ posts: [] }))

    expect(lane(events, ENTITIES_PLUGIN_NAME)).toEqual([
      { kind: 'update', entity: 'Post', id: 'p1', entries: 0, stale: 1, queries: [] },
    ])
    off()
    root.dispose()
  })
})
