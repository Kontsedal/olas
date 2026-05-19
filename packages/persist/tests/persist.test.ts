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
})
