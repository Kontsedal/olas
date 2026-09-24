// @vitest-environment jsdom
/**
 * The localStorage adapter against jsdom's real `localStorage` and `storage`
 * event, and the three entry points that fall back to it when no `storage`
 * is passed: `createPersisted`, `persistQueryCachePlugin` and
 * `restoreQueryCache`, plus `clearPersisted`'s default adapter.
 */
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
  signal,
} from '@kontsedal/olas-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearPersisted,
  createPersisted,
  localStorageAdapter,
  persistQueryCachePlugin,
  restoreQueryCache,
} from '../src'

/** What another tab's write looks like to this one. */
const remoteWrite = (key: string | null, newValue: string | null): void => {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
}

/**
 * Node 22+ defines its own global `localStorage` getter. Without
 * `--localstorage-file` it returns undefined, and it shadows jsdom's. Install
 * jsdom's `Storage` so the adapter meets a real one.
 */
const realLocalStorage = (): Storage =>
  typeof localStorage !== 'undefined'
    ? localStorage
    : (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window.localStorage

beforeAll(() => vi.stubGlobal('localStorage', realLocalStorage()))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('localStorageAdapter — against a real localStorage', () => {
  test('get, set and delete go through window.localStorage', () => {
    const adapter = localStorageAdapter()
    expect(adapter.get('alpha')).toBeNull()
    adapter.set('alpha', '1')
    expect(localStorage.getItem('alpha')).toBe('1')
    expect(adapter.get('alpha')).toBe('1')
    adapter.delete('alpha')
    expect(localStorage.getItem('alpha')).toBeNull()
  })

  test('every call returns the same adapter object', () => {
    expect(localStorageAdapter()).toBe(localStorageAdapter())
  })

  test('keys() lists every key in storage', async () => {
    localStorage.setItem('a', '1')
    localStorage.setItem('b', '2')
    const keys = await localStorageAdapter().keys?.()
    expect([...(keys ?? [])].sort()).toEqual(['a', 'b'])
  })

  test('keys() of an empty storage is empty', async () => {
    expect([...((await localStorageAdapter().keys?.()) ?? [])]).toEqual([])
  })

  test('onChange relays storage events until unsubscribed', () => {
    const seen: Array<[string, string | null]> = []
    const off = localStorageAdapter().onChange?.((key, value) => seen.push([key, value]))
    remoteWrite('k', 'v1')
    remoteWrite('k', null) // another tab removed the key
    expect(seen).toEqual([
      ['k', 'v1'],
      ['k', null],
    ])
    off?.()
    remoteWrite('k', 'after-off')
    expect(seen).toHaveLength(2)
  })

  test('onChange ignores a storage event with a null key (another tab called clear())', () => {
    const handler = vi.fn()
    const off = localStorageAdapter().onChange?.(handler)
    remoteWrite(null, null)
    expect(handler).not.toHaveBeenCalled()
    off?.()
  })
})

describe('createPersisted — the default storage is localStorage', () => {
  test('loads, writes and syncs across tabs with no storage option', () => {
    localStorage.setItem('theme', JSON.stringify('dark'))
    const def = defineController((ctx) => {
      const s = signal<string>('light')
      const p = createPersisted(ctx, 'theme', s, { crossTab: true })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    // localStorage reads synchronously: the value and `ready` are there at once.
    expect(root.api.s.value).toBe('dark')
    expect(root.api.ready.value).toBe(true)

    root.api.s.set('sepia')
    expect(localStorage.getItem('theme')).toBe(JSON.stringify('sepia'))

    remoteWrite('theme', JSON.stringify('contrast'))
    expect(root.api.s.value).toBe('contrast')
    root.dispose()
  })

  test('an explicit `storage: undefined` also falls back to localStorage', () => {
    localStorage.setItem('n', '7')
    const def = defineController((ctx) => {
      const s = signal<number>(0)
      createPersisted(ctx, 'n', s, { storage: undefined })
      return { s }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    expect(root.api.s.value).toBe(7)
    root.dispose()
  })
})

describe('clearPersisted — the default storage is localStorage', () => {
  test('a prefix deletes only the matching localStorage keys', async () => {
    localStorage.setItem('my-app/a', '1')
    localStorage.setItem('my-app/b', '2')
    localStorage.setItem('ga/cid', '3')
    await clearPersisted(undefined, { prefix: 'my-app/' })
    expect(localStorage.getItem('my-app/a')).toBeNull()
    expect(localStorage.getItem('my-app/b')).toBeNull()
    expect(localStorage.getItem('ga/cid')).toBe('3')
  })
})

describe('persistQueryCachePlugin + restoreQueryCache — the default storage is localStorage', () => {
  test('the plugin writes to "olas/query-cache" and restoreQueryCache reads it back', async () => {
    const q = defineQuery({
      id: 'cov-ls/user',
      key: () => [],
      fetcher: async () => ({ name: 'Ada' }),
      meta: { persist: true },
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, plugins: [persistQueryCachePlugin({ throttleMs: 0 })] },
    )
    await root.waitForIdle()
    root.dispose()

    const raw = localStorage.getItem('olas/query-cache')
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string) as { v: number; entries: Array<{ id: string }> }
    expect(stored.v).toBe(1)
    expect(stored.entries.map((e) => e.id)).toEqual(['cov-ls/user'])

    const hydrate = await restoreQueryCache()
    expect(hydrate?.entries.map((e) => [e.id, e.data])).toEqual([['cov-ls/user', { name: 'Ada' }]])
  })

  test('restoreQueryCache resolves undefined when localStorage holds nothing', async () => {
    await expect(restoreQueryCache()).resolves.toBeUndefined()
  })
})

describe('localStorageAdapter — without localStorage (SSR)', () => {
  test('reads are null, keys() is empty, and clearPersisted deletes nothing', async () => {
    vi.stubGlobal('localStorage', undefined)
    try {
      const adapter = localStorageAdapter()
      expect(adapter.get('k')).toBeNull()
      expect([...((await adapter.keys?.()) ?? [])]).toEqual([])
      const onError = vi.fn()
      await clearPersisted(undefined, { all: true, onError })
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('localStorage', realLocalStorage())
    }
  })
})
