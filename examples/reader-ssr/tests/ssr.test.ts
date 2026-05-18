// SSR round-trip — the headline test for this example.
//
// 1. Build a "server" root, await waitForIdle, dehydrate. Count api calls.
// 2. Build a fresh "client" root with `{ hydrate: state }`.
// 3. Subscribe to the feed.
// 4. Assert: no api calls were made on the client for the page the server
//    already cached.

import { describe, expect, test } from 'vitest'
import { createFakeApi } from '../src/api'
import { createAppRoot, setApiForQuery } from '../src/controller'

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('SSR dehydrate → hydrate', () => {
  test('client reads cursor-0 from cache; no fresh fetch', async () => {
    // --- Server side ---
    const serverApi = createFakeApi()
    setApiForQuery(serverApi)
    const server = createAppRoot({ api: serverApi })
    await server.waitForIdle()
    expect(serverApi.callCount).toBe(1) // only the initial page

    const state = server.dehydrate()
    expect(state.version).toBe(1)
    expect(state.entries.length).toBeGreaterThan(0)
    server.dispose()

    // --- Client side ---
    const clientApi = createFakeApi()
    setApiForQuery(clientApi)
    const client = createAppRoot({ api: clientApi }, state)
    await flush()

    // The client api was NEVER called — staleTime: 60_000 + hydrate seeded
    // the cache so the subscription read from it directly.
    expect(clientApi.callCount).toBe(0)
    // Data is visible immediately.
    expect(client.reader.flatArticles.value.length).toBe(4)

    client.dispose()
  })

  test('after hydrate, loadMore fetches the next cursor only', async () => {
    const serverApi = createFakeApi()
    setApiForQuery(serverApi)
    const server = createAppRoot({ api: serverApi })
    await server.waitForIdle()
    const state = server.dehydrate()
    server.dispose()

    const clientApi = createFakeApi()
    setApiForQuery(clientApi)
    const client = createAppRoot({ api: clientApi }, state)
    await flush()
    expect(client.reader.flatArticles.value.length).toBe(4)
    expect(clientApi.callCount).toBe(0)

    await client.reader.loadMore()
    await flush()
    expect(client.reader.flatArticles.value.length).toBe(8)
    expect(clientApi.callCount).toBe(1) // exactly one new fetch for cursor=1

    client.dispose()
  })
})
