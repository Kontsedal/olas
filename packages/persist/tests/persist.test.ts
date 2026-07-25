import { createRoot, defineController, signal } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
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

// ─── T6.1: version / migrate / throttleMs / onError (were untested) ──────────

describe('usePersisted — version + migrate', () => {
  test('version wraps writes in an envelope and reads them back', async () => {
    const store = memoryStorage()
    const def = defineController((ctx) => {
      const s = signal<string>('')
      const p = usePersisted(ctx, 'k', s, { storage: store, version: 2 })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.s.set('hello')
    expect(store.store.get('k')).toBe(JSON.stringify({ v: 2, d: JSON.stringify('hello') }))
    root.dispose()

    // A fresh root reads the envelope back.
    const def2 = defineController((ctx) => {
      const s = signal<string>('default')
      const p = usePersisted(ctx, 'k', s, { storage: store, version: 2 })
      return { s, ready: p.ready }
    })
    const r2 = createRoot(def2, { deps: emptyDeps })
    await flush()
    expect(r2.s.value).toBe('hello')
    r2.dispose()
  })

  test('migrate upgrades a legacy raw payload and rewrites the envelope', async () => {
    const store = memoryStorage({ k: JSON.stringify('v0-value') })
    const seen: Array<[string, number | undefined]> = []
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, {
        storage: store,
        version: 2,
        migrate: (raw, from) => {
          seen.push([raw, from])
          return `migrated:${JSON.parse(raw)}`
        },
      })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('migrated:v0-value')
    // Legacy raw shape → migrator sees fromVersion `undefined`.
    expect(seen).toEqual([[JSON.stringify('v0-value'), undefined]])
    // Rewritten as a v2 envelope.
    expect(store.store.get('k')).toBe(
      JSON.stringify({ v: 2, d: JSON.stringify('migrated:v0-value') }),
    )
    root.dispose()
  })

  test('migrate upgrades an older envelope version', async () => {
    const store = memoryStorage({ k: JSON.stringify({ v: 1, d: JSON.stringify('old') }) })
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, {
        storage: store,
        version: 2,
        migrate: (raw, from) => (from === 1 ? `up:${JSON.parse(raw)}` : undefined),
      })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('up:old')
    root.dispose()
  })

  test('migrate returning undefined drops the entry (source keeps its default)', async () => {
    const store = memoryStorage({ k: JSON.stringify({ v: 1, d: JSON.stringify('old') }) })
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      const p = usePersisted(ctx, 'k', s, { storage: store, version: 2, migrate: () => undefined })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('default')
    expect(root.ready.value).toBe(true)
    root.dispose()
  })

  test('version mismatch with no migrator discards the stored value', async () => {
    const store = memoryStorage({ k: JSON.stringify({ v: 1, d: JSON.stringify('old') }) })
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      usePersisted(ctx, 'k', s, { storage: store, version: 2 })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.s.value).toBe('default')
    root.dispose()
  })

  test('a throwing migrate routes onError("migrate") and keeps the default', async () => {
    const store = memoryStorage({ k: JSON.stringify({ v: 1, d: JSON.stringify('old') }) })
    const ops: string[] = []
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      usePersisted(ctx, 'k', s, {
        storage: store,
        version: 2,
        migrate: () => {
          throw new Error('migration boom')
        },
        onError: (_e, op) => ops.push(op),
      })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(ops).toContain('migrate')
    expect(root.s.value).toBe('default')
    root.dispose()
  })
})

describe('usePersisted — throttleMs', () => {
  test('debounces writes; only the last value lands after the delay', () => {
    vi.useFakeTimers()
    try {
      const store = memoryStorage()
      const def = defineController((ctx) => {
        const s = signal<number>(0)
        usePersisted(ctx, 'k', s, { storage: store, throttleMs: 100 })
        return { s }
      })
      const root = createRoot(def, { deps: emptyDeps })
      // Sync (memory) load → ready synchronously; no flush needed.
      root.s.set(1)
      root.s.set(2)
      root.s.set(3)
      expect(store.store.get('k')).toBeUndefined() // debounced — nothing yet
      vi.advanceTimersByTime(100)
      expect(store.store.get('k')).toBe('3') // only the latest
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a pending throttled write is flushed on dispose', () => {
    vi.useFakeTimers()
    try {
      const store = memoryStorage()
      const def = defineController((ctx) => {
        const s = signal<number>(0)
        usePersisted(ctx, 'k', s, { storage: store, throttleMs: 1000 })
        return { s }
      })
      const root = createRoot(def, { deps: emptyDeps })
      root.s.set(7)
      expect(store.store.get('k')).toBeUndefined()
      root.dispose() // flushes the pending write
      expect(store.store.get('k')).toBe('7')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('usePersisted — onError routing', () => {
  test('a synchronous storage.set throw routes onError("write"), not "serialize"', async () => {
    const ops: string[] = []
    const adapter: StorageAdapter = {
      get: () => null,
      set: () => {
        const e = new Error('quota') as Error & { name: string }
        e.name = 'QuotaExceededError'
        throw e
      },
      delete() {},
    }
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: adapter, onError: (_e, op) => ops.push(op) })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.s.set('x')
    await flush()
    expect(ops).toContain('write')
    expect(ops).not.toContain('serialize')
    root.dispose()
  })

  test('a throwing serialize routes onError("serialize") and writes nothing', async () => {
    const ops: string[] = []
    const store = memoryStorage()
    const def = defineController((ctx) => {
      const s = signal<unknown>(null)
      usePersisted(ctx, 'k', s, {
        storage: store,
        serialize: () => {
          throw new Error('not serializable')
        },
        onError: (_e, op) => ops.push(op),
      })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.s.set({ x: 1 })
    await flush()
    expect(ops).toContain('serialize')
    expect(store.store.has('k')).toBe(false)
    root.dispose()
  })

  test('an async storage.set rejection routes onError("write")', async () => {
    const ops: string[] = []
    const adapter: StorageAdapter = {
      get: () => null,
      set: () => Promise.reject(new Error('quota')),
      delete() {},
    }
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: adapter, onError: (_e, op) => ops.push(op) })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.s.set('x')
    await flush()
    expect(ops).toContain('write')
    root.dispose()
  })

  test('a corrupt cross-tab payload routes onError("remoteChange")', async () => {
    const store = memoryStorage({ k: JSON.stringify('start') })
    const ops: string[] = []
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, {
        storage: store,
        crossTab: true,
        onError: (_e, op) => ops.push(op),
      })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    store.emitChange('k', '{not json}')
    expect(ops).toContain('remoteChange')
    expect(root.s.value).toBe('start') // unchanged
    root.dispose()
  })

  test('a rejected async load routes onError("load")', async () => {
    const ops: string[] = []
    const adapter: StorageAdapter = {
      get: () => Promise.reject(new Error('db unavailable')),
      set() {},
      delete() {},
    }
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      const p = usePersisted(ctx, 'k', s, { storage: adapter, onError: (_e, op) => ops.push(op) })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(ops).toContain('load')
    expect(root.ready.value).toBe(true) // still settles ready
    expect(root.s.value).toBe('default')
    root.dispose()
  })
})

describe('usePersisted — ready-gate races (T6.1)', () => {
  test('a user write before the async load settles WINS (not clobbered)', async () => {
    let resolveGet: (v: string | null) => void = () => {}
    const writes: string[] = []
    const adapter: StorageAdapter = {
      get: () =>
        new Promise<string | null>((r) => {
          resolveGet = r
        }),
      set: (_k, v) => {
        writes.push(v)
      },
      delete() {},
    }
    const def = defineController((ctx) => {
      const s = signal<string>('')
      const p = usePersisted(ctx, 'k', s, { storage: adapter })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.ready.value).toBe(false)
    // User types BEFORE the load resolves.
    root.s.set('user-typed')
    await flush()
    // The load resolves with a DIFFERENT stored value — must NOT clobber.
    resolveGet(JSON.stringify('stored-value'))
    await flush()
    expect(root.s.value).toBe('user-typed')
    expect(writes).toContain(JSON.stringify('user-typed'))
    root.dispose()
  })

  test('a cross-tab change before the load settles is buffered, then applied', async () => {
    let resolveGet: (v: string | null) => void = () => {}
    const listeners = new Set<(k: string, v: string | null) => void>()
    const adapter: StorageAdapter = {
      get: () =>
        new Promise<string | null>((r) => {
          resolveGet = r
        }),
      set() {},
      delete() {},
      onChange(handler) {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    }
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: adapter, crossTab: true })
      return { s }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    // Remote change arrives before load settles → buffered, not applied.
    for (const l of listeners) l('k', JSON.stringify('from-peer'))
    expect(root.s.value).toBe('')
    // Load resolves with nothing stored → buffered remote applied.
    resolveGet(null)
    await flush()
    expect(root.s.value).toBe('from-peer')
    root.dispose()
  })
})
