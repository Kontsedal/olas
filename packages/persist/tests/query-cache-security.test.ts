/**
 * The stored query cache is state other same-origin code can write. A planted
 * entry must not stay fresh forever, and a corrupt one on async storage must
 * reach `onError` like on sync storage.
 */
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import { persistQueryCachePlugin, type StorageAdapter } from '../src'

const KEY = 'olas/query-cache'

function memory(opts: { async?: boolean } = {}): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>()
  const wrap = <T>(v: T): T | Promise<T> => (opts.async ? Promise.resolve(v) : v)
  return {
    store,
    get: (k) => wrap(store.get(k) ?? null),
    set: (k, v) => {
      store.set(k, v)
      return opts.async ? Promise.resolve() : undefined
    },
    delete: (k) => {
      store.delete(k)
      return opts.async ? Promise.resolve() : undefined
    },
  }
}

describe('persistQueryCachePlugin restore against stored data', () => {
  test('an entry dated in the future is dropped, so the query fetches', async () => {
    const storage = memory()
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [{ id: 'qc-sec/role', key: [], data: { role: 'admin' }, lastUpdatedAt: 9e15 }],
      }),
    )
    let fetches = 0
    const role = defineQuery({
      id: 'qc-sec/role',
      key: () => [],
      fetcher: async () => {
        fetches += 1
        return { role: 'viewer' }
      },
      staleTime: 60_000,
      meta: { persist: true },
    })
    const root = createRoot(
      defineController((ctx) => ({ role: createQuery(ctx, role) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage })],
      },
    )
    await root.waitForIdle()
    expect(fetches).toBe(1)
    expect(root.api.role.data.value).toEqual({ role: 'viewer' })
    root.dispose()
  })

  test('a corrupt payload on async storage reaches onError', async () => {
    const storage = memory({ async: true })
    storage.store.set(KEY, '{not json')
    const onError = vi.fn()
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, onError })],
      },
    )
    await root.waitForIdle()
    expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError), 'restore')
    root.dispose()
  })
})
