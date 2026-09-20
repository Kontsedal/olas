import { describe, expect, test } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import instanceSrc from '../src/controller/instance.ts?raw'
import rootSrc from '../src/controller/root.ts?raw'
import { createField, createForm } from '../src/forms/bind'
import { bindQuery, createCache, createMutation, createQuery } from '../src/query/bind'
import { defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import engineSrc from '../src/query/engine.ts?raw'

const noDeps = { deps: {} }

/**
 * These pin the property the ctx split exists for. A bundler can only drop a
 * subsystem that is not statically reachable from `createRoot`, so the guard
 * has to be on the import graph, not on a measured byte count that would drift
 * with every unrelated change.
 */
describe('createRoot does not statically reach the heavy subsystems', () => {
  test('instance.ts imports no forms or query implementation', () => {
    const src = instanceSrc
    // Type-only imports are erased and cannot retain anything.
    const valueImports = src
      .split('\n')
      .filter((line) => line.startsWith('import ') && !line.startsWith('import type '))
      .join('\n')
    expect(valueImports).not.toMatch(/from '\.\.\/forms\//)
    expect(valueImports).not.toMatch(/from '\.\.\/query\/(local|mutation|use|client|infinite)'/)
  })

  test('root.ts imports QueryClient as a type only', () => {
    const src = rootSrc
    expect(src).toMatch(/import type \{ QueryClient \} from '\.\.\/query\/client'/)
    expect(src).not.toMatch(/^import \{[^}]*QueryClient[^}]*\} from '\.\.\/query\/client'/m)
    // The constructor call must live in the engine, not here.
    expect(src).not.toMatch(/new QueryClient\(/)
  })

  test('query/engine.ts is the only value importer of the client', () => {
    expect(engineSrc).toMatch(/import \{ QueryClient \} from '\.\/client'/)
  })
})

describe('a root without a query engine', () => {
  const q = defineQuery({ key: () => ['x'] as const, fetcher: async () => 1 })

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
    await root.local.invalidate()
    expect(root.local.data.value).toBe(42)
    root.dispose()
  })

  test('forms work', () => {
    const def = defineController((ctx) => {
      const name = createField(ctx, 'ada')
      return { name, form: createForm(ctx, { name }) }
    })
    const root = createRoot(def, noDeps)
    expect(root.name.value).toBe('ada')
    expect(root.form.value.value).toEqual({ name: 'ada' })
    root.dispose()
  })

  test('dehydrate and waitForIdle stay usable', async () => {
    const root = createRoot(
      defineController(() => ({})),
      noDeps,
    )
    expect(root.dehydrate()).toEqual({ queries: [] })
    await expect(root.waitForIdle()).resolves.toBeUndefined()
    expect(root.__debug.queryEntries()).toEqual([])
    root.dispose()
  })
})

describe('a root with a query engine behaves as before', () => {
  test('createQuery subscribes', async () => {
    const q = defineQuery({ key: () => ['y'] as const, fetcher: async () => 'v' })
    const def = defineController((ctx) => ({ sub: createQuery(ctx, q) }))
    const root = createRoot(def, { ...noDeps, queries: queryEngine() })
    await root.waitForIdle()
    expect(root.sub.data.value).toBe('v')
    root.dispose()
  })
})

describe('ctx internals are not a public contract', () => {
  test('a hand-rolled ctx gets a named error rather than a property crash', () => {
    const fake = { deps: {} } as never
    expect(() => createField(fake, '')).toThrow(/not a controller ctx/)
  })
})
