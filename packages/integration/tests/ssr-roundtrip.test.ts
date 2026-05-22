/**
 * Scenario: full SSR roundtrip for a real-world page.
 *
 *   "server"  — mount the controller, wait for queries to fetch,
 *               dehydrate to a serializable payload.
 *   "wire"    — JSON-roundtrip the payload (simulates `JSON.stringify`
 *               into the HTML response + `JSON.parse` on the client).
 *   "client"  — mount a fresh root with the dehydrated state. Existing
 *               cache entries skip the fetcher; interactions still work
 *               (e.g. firing a mutation patches the hydrated data).
 *
 * Bonus checks:
 *   - The entities plugin sees hydrated data and populates its store.
 *   - Errors on the server are NOT dehydrated (only success).
 *   - Hydration with `staleTime: 0` refetches on first subscribe.
 */

import {
  createRoot,
  type DehydratedState,
  defineController,
  defineQuery,
  type Mutation,
  type QuerySubscription,
} from '@kontsedal/olas-core'
import { defineEntity, entitiesPlugin } from '@kontsedal/olas-entities'
import { describe, expect, test, vi } from 'vitest'
import { settle } from './_helpers'

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

// JSON roundtrip mimics the serialization barrier between server and client.
const wireTransport = <T>(state: T): T => JSON.parse(JSON.stringify(state)) as T

describe('integration: SSR roundtrip', () => {
  test('dehydrate → JSON → hydrate restores cached data; client does not re-fetch', async () => {
    const fetchSpy = vi.fn(async (id: string) => ({ id, name: `User ${id}` }))
    const userQuery = defineQuery({
      queryId: 'int/ssr/user',
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string) => fetchSpy(id),
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      user: ctx.use(userQuery, () => ['u1']),
    }))

    // --- Server ----------------------------------------------------------
    const server = createRoot(def, { deps: {} })
    await server.waitForIdle()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const dehydrated = server.dehydrate()
    expect(dehydrated.version).toBe(1)
    expect(dehydrated.entries.length).toBeGreaterThan(0)
    server.dispose()

    // --- Wire ------------------------------------------------------------
    const onWire = wireTransport(dehydrated) as DehydratedState
    expect(onWire.entries[0]?.key).toEqual(['user', 'u1'])
    expect(onWire.entries[0]?.data).toEqual({ id: 'u1', name: 'User u1' })

    // --- Client ----------------------------------------------------------
    const client = createRoot(def, { deps: {}, hydrate: onWire })
    await settle()
    type Api = { user: QuerySubscription<{ id: string; name: string }> }
    const c = client as unknown as Api & { dispose: () => void }
    expect(c.user.data.value).toEqual({ id: 'u1', name: 'User u1' })
    // staleTime: 60s — no refetch needed.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  test('entities plugin populates from hydrated data and supports backprop', async () => {
    const feedQuery = defineQuery({
      queryId: 'int/ssr/feed-hydrate',
      key: () => [],
      fetcher: async () => {
        throw new Error('fetcher must not run when hydrated')
      },
      staleTime: 60_000,
    })

    // Hand-built dehydrated payload — simulates a prior server render that
    // we ship to the client untouched. Real apps would use `dehydrate()`,
    // but this proves the contract: any well-formed payload hydrates.
    const dehydrated: DehydratedState = {
      version: 1,
      entries: [
        {
          key: [],
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

    const plugin = entitiesPlugin([Post])
    const def = defineController((ctx) => ({
      feed: ctx.use(feedQuery, () => []),
    }))
    type Api = { feed: QuerySubscription<{ posts: Post[]; pinned: Post }> }
    const client = createRoot(def, {
      deps: {},
      plugins: [plugin],
      hydrate: dehydrated,
    }) as unknown as Api & { dispose: () => void }

    // First paint — entity store already populated from the hydrated data.
    expect(client.feed.data.peek()?.posts[0]).toEqual({ id: 'p1', title: 'A', likes: 0 })
    expect(plugin.get(Post, 'p1')).toEqual({ id: 'p1', title: 'A', likes: 0 })
    expect(plugin.get(Post, 'p2')).toEqual({ id: 'p2', title: 'B', likes: 0 })

    // Backprop reaches both paths the hydrated value covers (posts.0 + pinned).
    plugin.update(Post, 'p1', { likes: 7 })
    expect(client.feed.data.peek()?.posts[0]?.likes).toBe(7)
    expect(client.feed.data.peek()?.pinned?.likes).toBe(7)

    client.dispose()
  })

  test('only success entries dehydrate; client re-fetches on mount', async () => {
    let fetches = 0
    const flaky = defineQuery({
      queryId: 'int/ssr/flaky',
      key: () => [],
      fetcher: async () => {
        fetches += 1
        if (fetches === 1) throw new Error('server transient failure')
        return { ok: true }
      },
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({ flaky: ctx.use(flaky, () => []) }))
    const server = createRoot(def, { deps: {}, onError: () => {} })
    await server.waitForIdle()
    const dehydrated = server.dehydrate()
    // Failed fetch produced no entry.
    expect(dehydrated.entries).toHaveLength(0)
    server.dispose()

    // Client mounts fresh; the fetcher runs again and now succeeds.
    const client = createRoot(def, { deps: {}, hydrate: dehydrated })
    await settle()
    type Api = { flaky: QuerySubscription<{ ok: boolean }> }
    const c = client as unknown as Api & { dispose: () => void }
    expect(c.flaky.data.value).toEqual({ ok: true })
    expect(fetches).toBe(2)
    c.dispose()
  })

  test('post-hydration mutation patches the hydrated cache without re-fetch', async () => {
    // The shipped state is "as if" the server rendered with two cards.
    // After hydration, a like-mutation should apply locally without
    // refetching the list.
    type Card = { id: string; title: string; likes: number }
    const cardsQuery = defineQuery({
      queryId: 'int/ssr/cards',
      key: () => [],
      fetcher: async (): Promise<Card[]> => {
        throw new Error('fetcher must not run after hydration')
      },
      staleTime: 60_000,
    })

    const dehydrated: DehydratedState = {
      version: 1,
      entries: [
        {
          key: [],
          data: [
            { id: 'c1', title: 'First', likes: 0 },
            { id: 'c2', title: 'Second', likes: 0 },
          ] as Card[],
          lastUpdatedAt: Date.now(),
        },
      ],
    }

    const def = defineController((ctx) => {
      const cards = ctx.use(cardsQuery, () => [])
      const like = ctx.mutation<string, void>({
        mutate: async (id) => {
          cardsQuery.setData(() => {
            const prev = cards.data.peek() ?? []
            return prev.map((c) => (c.id === id ? { ...c, likes: c.likes + 1 } : c))
          })
        },
      })
      return { cards, like }
    })

    type Api = {
      cards: QuerySubscription<Array<{ id: string; title: string; likes: number }>>
      like: Mutation<string, void>
    }
    const client = createRoot(def, { deps: {}, hydrate: dehydrated }) as unknown as Api & {
      dispose: () => void
    }

    expect(client.cards.data.peek()?.[0]).toEqual({ id: 'c1', title: 'First', likes: 0 })

    await client.like.run('c1')
    expect(client.cards.data.peek()?.[0]).toEqual({ id: 'c1', title: 'First', likes: 1 })
    expect(client.cards.data.peek()?.[1]).toEqual({ id: 'c2', title: 'Second', likes: 0 })

    client.dispose()
  })

  test('hydrated entries with staleTime: 0 still refetch on subscribe', async () => {
    let fetches = 0
    const q = defineQuery({
      queryId: 'int/ssr/stale-zero',
      key: () => [],
      fetcher: async () => {
        fetches += 1
        return fetches
      },
      // No staleTime — default 0.
    })

    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const server = createRoot(def, { deps: {} })
    await server.waitForIdle()
    expect(fetches).toBe(1)
    const dehydrated = wireTransport(server.dehydrate())
    server.dispose()

    const client = createRoot(def, { deps: {}, hydrate: dehydrated })
    await settle()
    // staleTime: 0 → subscribe triggers refetch; we end up at 2.
    expect(fetches).toBe(2)
    client.dispose()
  })
})
