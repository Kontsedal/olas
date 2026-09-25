import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import instanceSrc from '../src/controller/instance.ts?raw'
import rootSrc from '../src/controller/root.ts?raw'
import { createField, createForm } from '../src/forms/bind'
import { bindQuery, createCache, createMutation, createQuery } from '../src/query/bind'
import { defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

const noDeps = { deps: {} }

/**
 * These pin the property the ctx split exists for. A bundler can only drop a
 * subsystem that is not statically reachable from `createRoot`, so the guard
 * belongs on the import graph, not on a measured byte count that would drift
 * with every unrelated change.
 */
describe('createRoot does not statically reach the heavy subsystems', () => {
  /**
   * Normalize before matching. Biome wraps a long specifier list across lines,
   * which hides the `from '...'` clause from any line-by-line filter, and an
   * `export ... from` re-export retains a module just as hard as an import.
   */
  const valueEdges = (src: string): string[] => {
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const flattened = withoutComments.replace(/\s*\n\s*/g, ' ')
    return flattened.match(/\b(?:import|export)\s+(?!type\b)[^;']*from\s+'[^']+'/g) ?? []
  }

  test('instance.ts has no value edge into forms or the query implementation', () => {
    const edges = valueEdges(instanceSrc).join('\n')
    expect(edges).not.toMatch(/from '\.\.\/forms\//)
    expect(edges).not.toMatch(/from '\.\.\/query\/(local|mutation|use|client|infinite)'/)
  })

  test('root.ts imports QueryClient as a type only and never constructs one', () => {
    expect(rootSrc).toMatch(/import type \{[^}]*\bQueryClient\b[^}]*\} from '\.\.\/query\/client'/)
    expect(valueEdges(rootSrc).join('\n')).not.toMatch(/from '\.\.\/query\/client'/)
    expect(rootSrc).not.toMatch(/new QueryClient\(/)
  })

  test('neither instance.ts nor root.ts reaches query/engine.ts', () => {
    // The error helper lives in its own module for this reason. With it in
    // engine.ts, createRoot held a value edge into the module that constructs
    // the client, and the exclusion rested on export-level DCE rather than on
    // the graph.
    for (const src of [instanceSrc, rootSrc]) {
      expect(valueEdges(src).join('\n')).not.toMatch(/from '\.\.\/query\/engine'/)
    }
  })

  test('query/engine.ts is the ONLY value importer of the client', () => {
    // Exclusivity is the property. Asserting that engine.ts imports the client
    // proves nothing on its own — another module gaining that edge is exactly
    // what would silently undo the change.
    const all = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const importers = Object.entries(all)
      .filter(([path]) => !path.endsWith('/query/client.ts'))
      .filter(([, src]) => valueEdges(src).some((edge) => /from '[^']*client'/.test(edge)))
      .map(([path]) => path)
      .sort()
    expect(importers).toEqual(['../src/query/engine.ts'])
  })
})

describe('a root without a query engine', () => {
  const q = defineQuery({
    id: 'tree-shaking/71',
    key: () => ['x'] as const,
    fetcher: async () => 1,
  })

  test('createQuery names the fix', () => {
    const def = defineController((ctx) => {
      expect(() => createQuery(ctx, q)).toThrow(/needs a query engine/)
      expect(() => createQuery(ctx, q)).toThrow(/queries: queryEngine\(\)/)
      return {}
    })
    createRoot(def, noDeps)
  })

  test('createMutation and bindQuery name the fix too', () => {
    const def = defineController((ctx) => {
      expect(() => createMutation(ctx, { mutate: async () => 1 })).toThrow(/needs a query engine/)
      expect(() => bindQuery(ctx, q)).toThrow(/needs a query engine/)
      return {}
    })
    createRoot(def, noDeps)
  })

  test('createCache works — a local cache is not a client entry', async () => {
    const def = defineController((ctx) => ({
      local: createCache(ctx, async () => 42),
    }))
    const root = createRoot(def, noDeps)
    await root.api.local.invalidate()
    expect(root.api.local.data.value).toBe(42)
    root.dispose()
  })

  test('forms work', () => {
    const def = defineController((ctx) => {
      const name = createField(ctx, 'ada')
      return { name, form: createForm(ctx, { name }) }
    })
    const root = createRoot(def, noDeps)
    expect(root.api.name.value).toBe('ada')
    expect(root.api.form.value).toEqual({ name: 'ada' })
    root.dispose()
  })

  test('dehydrate produces a payload a hydrating root actually accepts', async () => {
    const root = createRoot(
      defineController(() => ({})),
      noDeps,
    )
    // Not `{ queries: [] }`. `QueryClient.hydrate` drops any payload whose
    // `version` is not 1, so a malformed empty state would warn on the
    // legitimate SSR render of a query-free root.
    const state = root.dehydrate()
    expect(state).toEqual({ version: 1, entries: [] })
    await expect(root.waitForIdle()).resolves.toBeUndefined()
    expect(root.debug.queryEntries()).toEqual([])
    root.dispose()

    const client = createRoot(
      defineController(() => ({})),
      { ...noDeps, queries: queryEngine(), hydrate: state },
    )
    expect(client.debug.queryEntries()).toEqual([])
    client.dispose()
  })

  test('hydrate without an engine warns; plugins still set up, with no query host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setup = vi.fn()
    const root = createRoot(
      defineController(() => ({})),
      {
        ...noDeps,
        plugins: [{ name: 'x', setup }],
        hydrate: { version: 1, entries: [] },
      },
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hydrate'))
    expect(setup).toHaveBeenCalledTimes(1)
    expect(setup.mock.calls[0]?.[0].queries).toBeNull()
    warn.mockRestore()
    root.dispose()
  })
})

describe('a root with a query engine behaves as before', () => {
  test('createQuery subscribes', async () => {
    const yq = defineQuery({
      id: 'tree-shaking/152',
      key: () => ['y'] as const,
      fetcher: async () => 'v',
    })
    const def = defineController((ctx) => ({ sub: createQuery(ctx, yq) }))
    const root = createRoot(def, { ...noDeps, queries: queryEngine() })
    await root.waitForIdle()
    expect(root.api.sub.data.value).toBe('v')
    root.dispose()
  })

  test('engine defaults reach createCache too', async () => {
    // The client and controller-local caches resolve defaults from different
    // places, so this is the seam where the two drift apart.
    const def = defineController((ctx) => ({ local: createCache(ctx, async () => 1) }))
    const root = createRoot(def, {
      ...noDeps,
      queries: queryEngine({ defaults: { staleTime: 300_000 } }),
    })
    await root.api.local.invalidate()
    expect(root.api.local.isStale.value).toBe(false)
    root.dispose()
  })
})

describe('ctx internals are not a public contract', () => {
  test('a hand-rolled ctx gets a named error rather than a property crash', () => {
    const fake = { deps: {} } as never
    expect(() => createField(fake, '')).toThrow(/not a controller ctx/)
  })
})

describe('streamed hydration on an engine-less root', () => {
  test('warns rather than dropping the entry in silence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = createRoot(
      defineController(() => ({})),
      noDeps,
    )
    root.hydrate({
      version: 1,
      entries: [{ id: 'app/user/v1', key: ['me'], data: { id: 'me' }, lastUpdatedAt: Date.now() }],
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('app/user/v1'))
    warn.mockRestore()
    root.dispose()
  })
})

describe('the internals handle is not on the public surface', () => {
  test('the barrel does not export CTX_INTERNALS', async () => {
    const barrel = (await import('../src/index')) as Record<string, unknown>
    expect(barrel.CTX_INTERNALS).toBeUndefined()
    // Still reachable for anyone who takes the risk knowingly — that is what
    // a registered symbol is for.
    expect(Symbol.for('olas.ctx.internals')).toBeDefined()
  })
})
