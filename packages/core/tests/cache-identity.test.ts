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

  test('an undefined member hashes as absent, as JSON writes it (§5.4)', () => {
    // A dehydrated key crosses JSON, which drops the member. Distinguishing the
    // two would make the entry unadoptable on the client.
    expect(stableHash([{ x: undefined }])).toBe(stableHash([{}]))
    expect(stableHash([{ nested: [{ x: undefined }] }])).toBe(stableHash([{ nested: [{}] }]))
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
      id: 'cache-identity/52',
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
  test('reversed registration order is safe', async () => {
    vi.resetModules()
    const serverModule = await import('../src/query/define')
    const spec = (name: string) => ({
      id: `ssr-order/${name}`,
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
    expect(state.entries).toHaveLength(2)
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
    expect(usersFetch).toHaveBeenCalledTimes(0)
    expect(settingsFetch).toHaveBeenCalledTimes(0)
  })

  test('a query without an id is rejected at definition time', () => {
    // Every entry in an SSR payload is named by its query's id. A query without
    // one used to be skipped by `dehydrate()` with a warning; now it cannot be
    // defined at all.
    const spec = { key: () => [], fetcher: async () => 'x' } as unknown as Parameters<
      typeof defineQuery
    >[0]
    expect(() => defineQuery(spec)).toThrow(/requires a non-empty `id`/)
    expect(() => defineQuery({ ...spec, id: '' })).toThrow(/requires a non-empty `id`/)
  })

  test('dehydrate stays quiet when every cached query is identified', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const q = defineQuery({
        id: 'dehydrate-warn/quiet',
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
    const q = defineQuery({
      id: 'cache-identity/176',
      key: () => [],
      fetcher: async () => 'own data',
      staleTime: Infinity,
    })
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

describe('the diverging-callArgs warning (dev)', () => {
  // A second bind of a key with other call args warns: the fetcher keeps the
  // first bind's args. The warning printed the key with `JSON.stringify`,
  // which throws on a bigint, so binding one crashed `createRoot` in dev. It
  // also compared args by identity, and warned on equal args built afresh.
  test('a bigint key does not crash the bind, and the warning names it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const q = defineQuery({
        id: 'cache-identity/bigint-warning',
        key: (n: bigint, _opts: { tag: string }) => [n],
        fetcher: async () => 'data',
      })
      const root = keep(
        createRoot(
          defineController((ctx) => ({
            a: createQuery(ctx, q, () => [1n, { tag: 'a' }]),
            b: createQuery(ctx, q, () => [1n, { tag: 'b' }]),
          })),
          { queries: queryEngine(), deps: {} },
        ),
      )
      expect(root.api.b.status.value).toBe('pending')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('1n')
    } finally {
      warn.mockRestore()
    }
  })

  test('equal call args built afresh do not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const q = defineQuery({
        id: 'cache-identity/equal-args',
        key: (filter: { page: number }) => [filter.page],
        fetcher: async () => 'data',
      })
      keep(
        createRoot(
          defineController((ctx) => ({
            a: createQuery(ctx, q, () => [{ page: 1 }]),
            b: createQuery(ctx, q, () => [{ page: 1 }]),
          })),
          { queries: queryEngine(), deps: {} },
        ),
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('call args holding a function still compare, by identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const q = defineQuery({
        id: 'cache-identity/function-args',
        key: (id: string, _onProgress: () => void) => [id],
        fetcher: async () => 'data',
      })
      const shared = (): void => {}
      keep(
        createRoot(
          defineController((ctx) => ({
            a: createQuery(ctx, q, () => ['x', shared]),
            b: createQuery(ctx, q, () => ['x', shared]),
            c: createQuery(ctx, q, () => ['x', () => {}]),
          })),
          { queries: queryEngine(), deps: {} },
        ),
      )
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
