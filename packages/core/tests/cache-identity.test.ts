import { afterEach, describe, expect, test, vi } from 'vitest'
import { createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { stableHash } from '../src/query/keys'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose()
})
const keep = <T extends { dispose(): void }>(root: T): T => {
  roots.push(root)
  return root
}

describe('cache key identities', () => {
  test.each([
    [undefined, '__undefined__'],
    [NaN, '__nan__'],
    [Infinity, '__+inf__'],
    [-Infinity, '__-inf__'],
    [1n, { __bigint: '1' }],
    [new Date(0), { __date: new Date(0).toISOString() }],
    [undefined, ['undefined']],
    [1n, ['bigint', '1']],
    [{}, []],
    [{ x: undefined }, {}],
    [JSON.parse('{"__proto__":{"x":1}}'), {}],
  ])('distinguishes key pair %#', (a, b) => {
    expect(stableHash([a])).not.toBe(stableHash([b]))
    expect(stableHash([{ nested: [a] }])).not.toBe(stableHash([{ nested: [b] }]))
  })

  test('normalizes -0 to 0 so arithmetic cannot split an entry', () => {
    // -0 is distinguishable via Object.is but equal under every equality a
    // caller touches, and JSON (the SSR transport) cannot represent it.
    expect(stableHash([-0])).toBe(stableHash([0]))
    expect(stableHash([{ offset: -0 }])).toBe(stableHash([{ offset: 0 }]))
    expect(stableHash([-0])).not.toBe(stableHash(['0']))
  })

  test('rejects cycles and supports shared acyclic references', () => {
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(() => stableHash(cycle)).toThrow(/cycles/)
    const child = { x: 1 }
    expect(stableHash([child, child])).toBe(stableHash([{ x: 1 }, { x: 1 }]))
  })

  test('colliding legacy markers produce independent requests and cached values', async () => {
    const q = defineQuery({
      key: (key: unknown) => [key],
      fetcher: async (_ctx, key: unknown) => typeof key,
      staleTime: Infinity,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          absent: createQuery(ctx, q, () => [undefined] as const),
          text: createQuery(ctx, q, () => ['__undefined__'] as const),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    expect(root.api.absent.data.peek()).toBe('undefined')
    expect(root.api.text.data.peek()).toBe('string')
  })
})

describe('SSR identity across separately evaluated bundles', () => {
  test.each([
    false,
    true,
  ])('reversed registration order is safe (explicit IDs: %s)', async (explicit) => {
    vi.resetModules()
    const serverModule = await import('../src/query/define')
    const spec = (name: string) => ({
      ...(explicit ? { queryId: `ssr-order/${name}` } : {}),
      key: () => [],
      fetcher: async () => name,
      staleTime: Infinity,
    })
    const serverUsers = serverModule.defineQuery(spec('users'))
    const serverSettings = serverModule.defineQuery(spec('settings'))
    const server = keep(
      createRoot(
        defineController((ctx) => ({
          users: createQuery(ctx, serverUsers),
          settings: createQuery(ctx, serverSettings),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await server.waitForIdle()
    const state = JSON.parse(JSON.stringify(server.dehydrate()))
    expect(state.entries).toHaveLength(explicit ? 2 : 0)
    server.dispose()

    vi.resetModules()
    const clientModule = await import('../src/query/define')
    const settingsFetch = vi.fn(async () => 'settings')
    const usersFetch = vi.fn(async () => 'users')
    const clientSettings = clientModule.defineQuery({ ...spec('settings'), fetcher: settingsFetch })
    const clientUsers = clientModule.defineQuery({ ...spec('users'), fetcher: usersFetch })
    const client = keep(
      createRoot(
        defineController((ctx) => ({
          users: createQuery(ctx, clientUsers),
          settings: createQuery(ctx, clientSettings),
        })),
        { queries: queryEngine(), deps: {}, hydrate: state },
      ),
    )
    await client.waitForIdle()
    expect(client.api.users.data.peek()).toBe('users')
    expect(client.api.settings.data.peek()).toBe('settings')
    expect(usersFetch).toHaveBeenCalledTimes(explicit ? 0 : 1)
    expect(settingsFetch).toHaveBeenCalledTimes(explicit ? 0 : 1)
  })

  test('dehydrate warns once about the cached entries it had to skip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const anon = defineQuery({ key: (id: string) => [id], fetcher: async (_c, id: string) => id })
      const named = defineQuery({
        queryId: 'dehydrate-warn/named',
        key: () => [],
        fetcher: async () => 'named',
      })
      const root = keep(
        createRoot(
          defineController((ctx) => ({
            a: createQuery(ctx, anon, () => ['a'] as const),
            b: createQuery(ctx, anon, () => ['b'] as const),
            named: createQuery(ctx, named),
          })),
          { queries: queryEngine(), deps: {} },
        ),
      )
      await root.waitForIdle()
      const state = root.dehydrate()
      // The named query still ships; only the anonymous entries are dropped.
      expect(state.entries.map((e) => e.id)).toEqual(['dehydrate-warn/named'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/skipped 2 cached entries.*queryId/s)
    } finally {
      warn.mockRestore()
    }
  })

  test('dehydrate stays quiet when every cached query is identified', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const q = defineQuery({
        queryId: 'dehydrate-warn/quiet',
        key: () => [],
        fetcher: async () => 'v',
      })
      const root = keep(
        createRoot(
          defineController((ctx) => ({ sub: createQuery(ctx, q) })),
          { queries: queryEngine(), deps: {} },
        ),
      )
      await root.waitForIdle()
      expect(root.dehydrate().entries).toHaveLength(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('anonymous queries cannot consume legacy auto-ID payloads', async () => {
    const q = defineQuery({ key: () => [], fetcher: async () => 'own data', staleTime: Infinity })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ sub: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
          hydrate: {
            version: 1,
            entries: [{ id: ' auto:0', key: [], data: 'wrong data', lastUpdatedAt: Date.now() }],
          },
        },
      ),
    )
    expect(root.api.sub.data.peek()).toBeUndefined()
    await root.waitForIdle()
    expect(root.api.sub.data.peek()).toBe('own data')
  })
})
