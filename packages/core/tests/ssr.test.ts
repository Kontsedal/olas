import { describe, expect, test } from 'vitest'
import { createMutation, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('dehydrate / hydrate', () => {
  test('dehydrate → hydrate round-trip restores cached data without re-fetching', async () => {
    let fetchCount = 0
    const userQuery = defineQuery({
      id: 'ssr/basic-1',
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string) => {
        fetchCount++
        return { id, name: `User ${id}` }
      },
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      user: createQuery(ctx, userQuery, () => ['u1']),
    }))

    // Server side: fetch + dehydrate.
    const server = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await server.waitForIdle()
    expect(fetchCount).toBe(1)
    const state = server.dehydrate()
    expect(state.version).toBe(1)
    expect(state.entries.length).toBeGreaterThan(0)
    server.dispose()

    // Client side: hydrate before subscribing.
    const client = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    await flush()
    expect(client.api.user.data.value).toEqual({ id: 'u1', name: 'User u1' })
    // staleTime: 60_000 — no refetch.
    expect(fetchCount).toBe(1)
    client.dispose()
  })

  test('hydrated entries respect staleTime: 0 (refetch on subscribe)', async () => {
    let fetchCount = 0
    const q = defineQuery({
      id: 'ssr/basic-2',
      key: () => ['x'],
      fetcher: async () => {
        fetchCount++
        return fetchCount
      },
    })

    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const server = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await server.waitForIdle()
    const state = server.dehydrate()
    server.dispose()

    const client = createRoot(def, { queries: queryEngine(), deps: emptyDeps, hydrate: state })
    await flush()
    // staleTime is 0 (default), so subscribe sees stale and refetches.
    expect(fetchCount).toBe(2)
    client.dispose()
  })

  test('only successful entries are serialized', async () => {
    const q = defineQuery({
      id: 'ssr/basic-3',
      key: () => ['error'],
      fetcher: async () => {
        throw new Error('nope')
      },
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await root.waitForIdle()
    const state = root.dehydrate()
    expect(state.entries.length).toBe(0)
    root.dispose()
  })
})

describe('waitForIdle', () => {
  test('resolves when no fetches are in flight', async () => {
    const def = defineController(() => ({}))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await expect(root.waitForIdle()).resolves.toBeUndefined()
    root.dispose()
  })

  test('blocks until a slow fetch completes', async () => {
    let resolveFetch: (() => void) | null = null
    const q = defineQuery({
      id: 'ssr/basic-4',
      key: () => ['slow'],
      fetcher: () =>
        new Promise<number>((r) => {
          resolveFetch = () => r(42)
        }),
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    let resolved = false
    const idlePromise = root.waitForIdle().then(() => {
      resolved = true
    })
    await flush()
    expect(resolved).toBe(false)
    resolveFetch!()
    await idlePromise
    expect(resolved).toBe(true)
    root.dispose()
  })

  test('blocks until in-flight mutations settle', async () => {
    let resolveMutate: (() => void) | null = null
    const def = defineController((ctx) => ({
      save: createMutation(ctx, {
        mutate: () =>
          new Promise<void>((r) => {
            resolveMutate = () => r()
          }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const runPromise = root.api.save.run(undefined)
    await flush()
    let idle = false
    const idlePromise = root.waitForIdle().then(() => {
      idle = true
    })
    await flush()
    expect(idle).toBe(false)
    resolveMutate!()
    await runPromise
    await idlePromise
    expect(idle).toBe(true)
    root.dispose()
  })
})
