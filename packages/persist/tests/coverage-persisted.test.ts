/**
 * `createPersisted` edges the main suite leaves open: versioned cross-tab
 * payloads, the legacy-payload migrator's drop and throw exits, a user write
 * racing an async migrate, the migrated value's rewrite failing, and
 * `clearPersisted` over async and failing enumerations.
 */
import { createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clearPersisted, createPersisted, type PersistErrorOp, type StorageAdapter } from '../src'

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
    emitChange(key, value) {
      for (const l of listeners) l(key, value)
    },
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
    onChange(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** The envelope versions before 1.0 wrote, which every version still reads. */
const envelope = (v: number, value: unknown) => JSON.stringify({ v, d: JSON.stringify(value) })
/** The marked envelope 1.0 writes. */
const marked = (v: number, value: unknown) =>
  JSON.stringify({ $olas: 1, v, d: JSON.stringify(value) })

describe('createPersisted — cross-tab payloads under a version', () => {
  const mount = (storage: StorageAdapter) => {
    const def = defineController((ctx) => {
      const s = signal<string>('')
      createPersisted(ctx, 'k', s, { storage, crossTab: true, version: 2 })
      return { s }
    })
    return createRoot(def, { queries: queryEngine(), deps: {} })
  }

  test('a peer envelope on the same version is unwrapped and applied', () => {
    const storage = memoryStorage({ k: envelope(2, 'initial') })
    const root = mount(storage)
    expect(root.api.s.value).toBe('initial')
    storage.emitChange('k', envelope(2, 'from-peer'))
    expect(root.api.s.value).toBe('from-peer')
    // Applying a remote value does not echo it back to storage.
    expect(storage.store.get('k')).toBe(envelope(2, 'initial'))
    root.dispose()
  })

  test('a peer envelope on another version is ignored', () => {
    const storage = memoryStorage({ k: envelope(2, 'initial') })
    const root = mount(storage)
    storage.emitChange('k', envelope(3, 'newer-schema'))
    expect(root.api.s.value).toBe('initial')
    root.dispose()
  })

  test('a peer payload without an envelope is deserialized as is', () => {
    const storage = memoryStorage({ k: envelope(2, 'initial') })
    const root = mount(storage)
    storage.emitChange('k', JSON.stringify('legacy-peer'))
    expect(root.api.s.value).toBe('legacy-peer')
    root.dispose()
  })
})

describe('createPersisted — a throttled write and a newer cross-tab change', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('the pending write is dropped, so it cannot put the older value back', async () => {
    // Tab A throttles its writes; tab B writes storage directly.
    const storage = memoryStorage()
    const def = defineController((ctx) => {
      const s = signal<string>('')
      createPersisted(ctx, 'k', s, { storage, crossTab: true, throttleMs: 1000 })
      return { s }
    })
    const tabA = createRoot(def, { queries: queryEngine(), deps: {} })
    tabA.api.s.set('a')
    await vi.advanceTimersByTimeAsync(500)
    // Tab B's write lands in storage, and the storage event reaches tab A.
    storage.store.set('k', JSON.stringify('b'))
    storage.emitChange('k', JSON.stringify('b'))
    expect(tabA.api.s.value).toBe('b')
    await vi.advanceTimersByTimeAsync(1000)
    // Storage still agrees with both tabs.
    expect(storage.store.get('k')).toBe(JSON.stringify('b'))
    // A later local write still persists, on its own throttle window.
    tabA.api.s.set('c')
    await vi.advanceTimersByTimeAsync(1000)
    expect(storage.store.get('k')).toBe(JSON.stringify('c'))
    tabA.dispose()
  })

  test('a cross-tab delete drops the pending write too', async () => {
    const storage = memoryStorage()
    const def = defineController((ctx) => {
      const s = signal<string | undefined>('')
      createPersisted(ctx, 'k', s, { storage, crossTab: true, throttleMs: 1000 })
      return { s }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    root.api.s.set('a')
    storage.emitChange('k', null)
    expect(root.api.s.value).toBeUndefined()
    root.dispose() // dispose flushes a pending write; there is none
    expect(storage.store.has('k')).toBe(false)
  })
})

describe('createPersisted — cross-tab payloads that need migrating', () => {
  type V2 = { theme: { mode: string } }
  const mountV2 = (
    storage: StorageAdapter,
    migrate: (raw: string, from: number | undefined) => V2 | undefined | Promise<V2 | undefined>,
  ) => {
    const errors: Array<[unknown, PersistErrorOp]> = []
    const def = defineController((ctx) => {
      const s = signal<V2>({ theme: { mode: 'light' } })
      createPersisted(ctx, 'prefs', s, {
        storage,
        crossTab: true,
        version: 2,
        migrate,
        onError: (err, op) => errors.push([err, op]),
      })
      return { s }
    })
    return { root: createRoot(def, { queries: queryEngine(), deps: {} }), errors }
  }
  const upgrade = (raw: string): V2 => {
    const old = JSON.parse(raw) as { theme: string }
    return { theme: { mode: old.theme } }
  }

  test('a legacy payload from an old-build tab is migrated, as the load path does', () => {
    const storage = memoryStorage()
    const { root } = mountV2(storage, upgrade)
    storage.emitChange('prefs', JSON.stringify({ theme: 'dark' }))
    expect(root.api.s.value).toEqual({ theme: { mode: 'dark' } })
    // The old build owns what it wrote: this tab does not rewrite it.
    expect(storage.store.has('prefs')).toBe(false)
    root.dispose()
  })

  test('an older envelope is migrated, and a migrator returning undefined drops the change', () => {
    const storage = memoryStorage()
    const seen: Array<number | undefined> = []
    const { root } = mountV2(storage, (raw, from) => {
      seen.push(from)
      return from === 1 ? upgrade(raw) : undefined
    })
    storage.emitChange('prefs', marked(1, { theme: 'dark' }))
    expect(root.api.s.value).toEqual({ theme: { mode: 'dark' } })
    storage.emitChange('prefs', marked(3, { theme: { mode: 'newer' }, extra: true }))
    expect(root.api.s.value).toEqual({ theme: { mode: 'dark' } })
    expect(seen).toEqual([1, 3])
    root.dispose()
  })

  test('a migrator that throws reports "migrate" and leaves the value', () => {
    const storage = memoryStorage()
    const boom = new Error('cannot migrate')
    const { root, errors } = mountV2(storage, () => {
      throw boom
    })
    storage.emitChange('prefs', JSON.stringify({ theme: 'dark' }))
    expect(root.api.s.value).toEqual({ theme: { mode: 'light' } })
    expect(errors).toEqual([[boom, 'migrate']])
    root.dispose()
  })

  test('an async migrate applies unless a newer change or a local write came first', async () => {
    const storage = memoryStorage()
    const pending: Array<(v: V2) => void> = []
    const { root } = mountV2(
      storage,
      () =>
        new Promise<V2>((resolve) => {
          pending.push(resolve)
        }),
    )
    storage.emitChange('prefs', JSON.stringify({ theme: 'dark' }))
    expect(root.api.s.value).toEqual({ theme: { mode: 'light' } })
    pending[0]?.({ theme: { mode: 'dark' } })
    await flush()
    expect(root.api.s.value).toEqual({ theme: { mode: 'dark' } })

    // A second legacy change is still migrating when the user edits locally.
    storage.emitChange('prefs', JSON.stringify({ theme: 'sepia' }))
    root.api.s.set({ theme: { mode: 'mine' } })
    pending[1]?.({ theme: { mode: 'sepia' } })
    await flush()
    expect(root.api.s.value).toEqual({ theme: { mode: 'mine' } })

    // A newer same-version change outranks a migration still in flight.
    storage.emitChange('prefs', JSON.stringify({ theme: 'old' }))
    storage.emitChange('prefs', marked(2, { theme: { mode: 'current' } }))
    expect(root.api.s.value).toEqual({ theme: { mode: 'current' } })
    pending[2]?.({ theme: { mode: 'old' } })
    await flush()
    expect(root.api.s.value).toEqual({ theme: { mode: 'current' } })
    root.dispose()
  })
})

describe('createPersisted — migrating a legacy payload', () => {
  test('a migrator returning undefined drops it: the default stays, storage is not rewritten', async () => {
    const storage = memoryStorage({ k: JSON.stringify('legacy') })
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      const p = createPersisted(ctx, 'k', s, {
        storage,
        version: 2,
        migrate: () => undefined,
      })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    await flush()
    expect(root.api.s.value).toBe('default')
    expect(root.api.ready.value).toBe(true)
    expect(storage.store.get('k')).toBe(JSON.stringify('legacy'))
    root.dispose()
  })

  test('a migrator that throws routes onError("migrate") and flips ready', async () => {
    const storage = memoryStorage({ k: JSON.stringify('legacy') })
    const errors: Array<[unknown, PersistErrorOp, string]> = []
    const boom = new Error('cannot migrate')
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      const p = createPersisted(ctx, 'k', s, {
        storage,
        version: 2,
        migrate: () => {
          throw boom
        },
        onError: (err, op, key) => errors.push([err, op, key]),
      })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    await flush()
    expect(errors).toEqual([[boom, 'migrate', 'k']])
    expect(root.api.s.value).toBe('default')
    expect(root.api.ready.value).toBe(true)
    root.dispose()
  })

  test('a user write during an async migrate wins over the migrated value', async () => {
    const storage = memoryStorage({ k: envelope(1, 'old') })
    let finishMigrate: (value: string) => void = () => {}
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      const p = createPersisted(ctx, 'k', s, {
        storage,
        version: 2,
        migrate: () =>
          new Promise<string>((resolve) => {
            finishMigrate = resolve
          }),
      })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    expect(root.api.ready.value).toBe(false) // waiting on the migrator
    root.api.s.set('typed-by-user')

    finishMigrate('migrated')
    await flush()
    expect(root.api.ready.value).toBe(true)
    expect(root.api.s.value).toBe('typed-by-user')
    expect(storage.store.get('k')).toBe(marked(2, 'typed-by-user'))
    root.dispose()
  })
})

describe('createPersisted — rewriting a migrated value', () => {
  const mountMigrating = (
    storage: StorageAdapter,
    extra: { serialize?: (v: string) => string },
  ) => {
    const errors: Array<[unknown, PersistErrorOp]> = []
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      createPersisted(ctx, 'k', s, {
        storage,
        version: 2,
        migrate: (raw) => `up:${JSON.parse(raw)}`,
        onError: (err, op) => errors.push([err, op]),
        ...extra,
      })
      return { s }
    })
    return { root: createRoot(def, { queries: queryEngine(), deps: {} }), errors }
  }

  test('a serialize failure is reported as "serialize"; the migrated value still applies', async () => {
    const storage = memoryStorage({ k: envelope(1, 'old') })
    const bad = new Error('not serializable')
    const { root, errors } = mountMigrating(storage, {
      serialize: () => {
        throw bad
      },
    })
    await flush()
    expect(root.api.s.value).toBe('up:old')
    expect(errors).toEqual([[bad, 'serialize']])
    expect(storage.store.get('k')).toBe(envelope(1, 'old'))
    root.dispose()
  })

  test('a synchronous storage throw is reported as "write"', async () => {
    const storage = memoryStorage({ k: envelope(1, 'old') })
    const quota = new Error('QuotaExceededError')
    storage.set = () => {
      throw quota
    }
    const { root, errors } = mountMigrating(storage, {})
    await flush()
    expect(root.api.s.value).toBe('up:old')
    expect(errors).toEqual([[quota, 'write']])
    root.dispose()
  })

  test('an async storage rejection is reported as "write"', async () => {
    const storage = memoryStorage({ k: envelope(1, 'old') })
    const quota = new Error('QuotaExceededError')
    storage.set = () => Promise.reject(quota)
    const { root, errors } = mountMigrating(storage, {})
    await flush()
    expect(root.api.s.value).toBe('up:old')
    expect(errors).toEqual([[quota, 'write']])
    root.dispose()
  })
})

describe('clearPersisted — enumeration and async deletes', () => {
  test('awaits an async keys() and async deletes', async () => {
    const store = new Map(Object.entries({ 'app/a': '1', 'app/b': '2', other: '3' }))
    const deleted: string[] = []
    const storage: StorageAdapter = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        store.set(k, v)
      },
      delete: async (k) => {
        await Promise.resolve()
        store.delete(k)
        deleted.push(k)
      },
      keys: async () => [...store.keys()],
    }
    await clearPersisted(storage, { prefix: 'app/' })
    // Every delete finished before clearPersisted resolved.
    expect(deleted).toEqual(['app/a', 'app/b'])
    expect([...store.keys()]).toEqual(['other'])
  })

  test('a keys() that throws is reported under "<keys>" and deletes nothing', async () => {
    const store = new Map(Object.entries({ 'app/a': '1' }))
    const failure = new Error('SecurityError')
    const storage: StorageAdapter = {
      get: (k) => store.get(k) ?? null,
      set: (k, v) => {
        store.set(k, v)
      },
      delete: (k) => {
        store.delete(k)
      },
      keys: () => {
        throw failure
      },
    }
    const seen: Array<[unknown, string]> = []
    await clearPersisted(storage, { all: true, onError: (err, key) => seen.push([err, key]) })
    expect(seen).toEqual([[failure, '<keys>']])
    expect(store.size).toBe(1)
  })

  test('a keys() that rejects is reported under "<keys>" too', async () => {
    const failure = new Error('db closed')
    const storage: StorageAdapter = {
      get: () => null,
      set: () => {},
      delete: () => {
        throw new Error('must not be called')
      },
      keys: () => Promise.reject(failure),
    }
    const seen: Array<[unknown, string]> = []
    await clearPersisted(storage, { all: true, onError: (err, key) => seen.push([err, key]) })
    expect(seen).toEqual([[failure, '<keys>']])
  })

  test('without onError, a failed enumeration resolves silently', async () => {
    const storage: StorageAdapter = {
      get: () => null,
      set: () => {},
      delete: () => {},
      keys: () => {
        throw new Error('nope')
      },
    }
    await expect(clearPersisted(storage, { all: true })).resolves.toBeUndefined()
  })
})
