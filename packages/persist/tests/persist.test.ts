import { createRoot, defineController, signal } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { type StorageAdapter, usePersisted } from '../src'

const emptyDeps = {}

const memoryStorage = (
  initial: Record<string, string> = {},
): StorageAdapter & {
  store: Map<string, string>
  emitChange: (key: string, value: string | null) => void
} => {
  const store = new Map(Object.entries(initial))
  const listeners = new Set<(key: string, value: string | null) => void>()
  return {
    store,
    emitChange(key: string, value: string | null) {
      for (const l of listeners) l(key, value)
    },
    get(key) {
      return store.get(key) ?? null
    },
    set(key, value) {
      store.set(key, value)
    },
    delete(key) {
      store.delete(key)
    },
    onChange(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('usePersisted', () => {
  test('loads initial value from storage on construction', async () => {
    const store = memoryStorage({ draft: JSON.stringify('hello') })
    const def = defineController((ctx) => {
      const s = signal<string>('')
      const persisted = usePersisted(ctx, 'draft', s, { storage: store })
      return { s, ready: persisted.ready }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('hello')
    expect(root.ready.value).toBe(true)
    root.dispose()
  })

  test('persists subsequent writes to storage', async () => {
    const store = memoryStorage()
    const def = defineController((ctx) => {
      const s = signal<number>(0)
      usePersisted(ctx, 'counter', s, { storage: store })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.s.set(42)
    expect(store.store.get('counter')).toBe('42')
    root.dispose()
  })

  test('ready stays false until async load resolves', async () => {
    let resolve: (v: string | null) => void = () => {}
    const adapter: StorageAdapter = {
      get: () =>
        new Promise<string | null>((r) => {
          resolve = r
        }),
      set() {},
      delete() {},
    }
    const def = defineController((ctx) => {
      const s = signal<string>('')
      const p = usePersisted(ctx, 'x', s, { storage: adapter })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.ready.value).toBe(false)

    resolve(JSON.stringify('loaded'))
    await flush()
    expect(root.ready.value).toBe(true)
    expect(root.s.value).toBe('loaded')
    root.dispose()
  })

  test('crossTab=true syncs from storage onChange events', async () => {
    const store = memoryStorage({ k: JSON.stringify('initial') })
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: store, crossTab: true })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('initial')

    store.emitChange('k', JSON.stringify('updated'))
    expect(root.s.value).toBe('updated')
    root.dispose()
  })

  test('disposal unsubscribes from storage and source', async () => {
    const store = memoryStorage()
    const def = defineController((ctx) => {
      const s = signal<number>(0)
      usePersisted(ctx, 'n', s, { storage: store })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.dispose()
    // After dispose, source changes should NOT write to storage.
    // We can't get the signal post-dispose from root, so test via fresh.
    const s = signal<number>(5)
    let writeCount = 0
    const trackingStore: StorageAdapter = {
      get: () => null,
      set: () => {
        writeCount++
      },
      delete: () => {},
    }
    const def2 = defineController((ctx) => {
      usePersisted(ctx, 'x', s, { storage: trackingStore })
      return {}
    })
    const r2 = createRoot(def2, { deps: emptyDeps })
    await flush()
    s.set(10)
    expect(writeCount).toBe(1)
    r2.dispose()
    s.set(20)
    expect(writeCount).toBe(1)
  })

  test('corrupted storage value falls back silently to source default', async () => {
    const store = memoryStorage({ broken: '{not json' })
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      usePersisted(ctx, 'broken', s, { storage: store })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('default')
    root.dispose()
  })

  test('rejected async storage.set is swallowed (does not crash the app)', async () => {
    const adapter: StorageAdapter = {
      get: () => null,
      set: () => Promise.reject(new Error('quota exceeded')),
      delete: () => {},
    }
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: adapter })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.s.set('payload')
    await flush()
    // No assertion target beyond "didn't throw" — covers the .catch swallow.
    root.dispose()
  })

  test('serialize throwing is swallowed (covers the outer catch)', async () => {
    const store = memoryStorage()
    const def = defineController((ctx) => {
      const s = signal<unknown>(null)
      usePersisted(ctx, 'k', s, {
        storage: store,
        serialize: () => {
          throw new Error('not serializable')
        },
      })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.s.set({ cycles: 'pretend this loops back to itself' })
    expect(store.store.has('k')).toBe(false)
    root.dispose()
  })

  test('crossTab onChange with rawValue=null mirrors as undefined to source', async () => {
    const store = memoryStorage({ k: JSON.stringify('keep me') })
    const def = defineController((ctx) => {
      const s = signal<string | undefined>('initial')
      usePersisted(ctx, 'k', s, { storage: store, crossTab: true })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('keep me')

    // Another tab calls localStorage.removeItem → onChange fires with null.
    store.emitChange('k', null)
    expect(root.s.value).toBeUndefined()
    root.dispose()
  })

  test('crossTab onChange ignores keys that do not match', async () => {
    const store = memoryStorage({ k: JSON.stringify('mine') })
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: store, crossTab: true })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()

    store.emitChange('other-key', JSON.stringify('not mine'))
    expect(root.s.value).toBe('mine')
    root.dispose()
  })

  test('crossTab onChange swallows corrupted payloads', async () => {
    const store = memoryStorage({ k: JSON.stringify('start') })
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: store, crossTab: true })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    store.emitChange('k', '{not json}')
    expect(root.s.value).toBe('start')
    root.dispose()
  })
})

describe('localStorageAdapter', () => {
  test('round-trips through the real localStorage when present', async () => {
    const { localStorageAdapter } = await import('../src')
    // jsdom provides localStorage; node-only environment skips.
    if (typeof localStorage === 'undefined') return
    localStorage.clear()
    localStorageAdapter.set('alpha', '1')
    expect(localStorageAdapter.get('alpha')).toBe('1')
    localStorageAdapter.delete('alpha')
    expect(localStorageAdapter.get('alpha')).toBeNull()
  })

  test('no-ops gracefully when localStorage is absent', async () => {
    const { localStorageAdapter } = await import('../src')
    const originalLS = (globalThis as { localStorage?: Storage }).localStorage
    const originalWin = (globalThis as { window?: Window }).window
    delete (globalThis as { localStorage?: Storage }).localStorage
    delete (globalThis as { window?: Window }).window
    try {
      expect(localStorageAdapter.get('x')).toBeNull()
      // set/delete return void and shouldn't throw.
      localStorageAdapter.set('x', '1')
      localStorageAdapter.delete('x')
      const off = localStorageAdapter.onChange?.(() => {})
      expect(off).toBeDefined()
      off?.()
    } finally {
      if (originalLS) (globalThis as { localStorage?: Storage }).localStorage = originalLS
      if (originalWin) (globalThis as { window?: Window }).window = originalWin
    }
  })
})
