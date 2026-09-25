/**
 * `createPersisted` with a source set to `undefined`. `JSON.stringify(undefined)`
 * is `undefined`, not a string. With `version` the writer dropped `d` and
 * stored `{"$olas":1,"v":N}`, which read back as that object. Without it the
 * escape check threw on the missing string, storage kept the old value, and a
 * reload brought back what the user cleared. A reload and a peer tab now both
 * read `undefined`, and a peer's delete reads as a reload of a missing key does.
 */
import { createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import {
  createPersisted,
  type PersistErrorOp,
  type PersistOptions,
  type StorageAdapter,
} from '../src'

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

function mount(storage: StorageAdapter, options: PersistOptions<string | undefined> = {}) {
  const def = defineController((ctx) => {
    const s = signal<string | undefined>('default')
    createPersisted(ctx, 'k', s, { storage, ...options })
    return { s }
  })
  return createRoot(def, { queries: queryEngine(), deps: {} })
}

describe.each([
  ['without version', {}],
  ['with version', { version: 2 }],
])('createPersisted — a source set to undefined, %s', (_label, options) => {
  test('a reload reads undefined, not the default and not the old value', () => {
    const storage = memoryStorage()
    const first = mount(storage, options)
    first.api.s.set('draft')
    first.api.s.set(undefined)
    first.dispose()

    const reload = mount(storage, options)
    expect(reload.api.s.value).toBeUndefined()
    reload.dispose()
  })

  test('a peer tab reads undefined', () => {
    const storage = memoryStorage()
    const writer = mount(storage, options)
    const peer = mount(storage, { ...options, crossTab: true })
    writer.api.s.set('draft')
    storage.emitChange('k', storage.get('k') as string)
    expect(peer.api.s.value).toBe('draft')

    writer.api.s.set(undefined)
    storage.emitChange('k', storage.get('k') as string)
    expect(peer.api.s.value).toBeUndefined()
    writer.dispose()
    peer.dispose()
  })

  test("a peer's delete reads as a reload of a missing key does: the default", () => {
    const storage = memoryStorage()
    const tab = mount(storage, { ...options, crossTab: true })
    tab.api.s.set('draft')
    storage.store.delete('k')
    storage.emitChange('k', null)
    expect(tab.api.s.value).toBe('default')
    // Nothing echoes the default back to storage.
    expect(storage.store.has('k')).toBe(false)
    tab.dispose()

    const reload = mount(storage, options)
    expect(reload.api.s.value).toBe('default')
    reload.dispose()
  })
})

describe('createPersisted — undefined and the stored format', () => {
  test('the envelope the old versioned writer left for undefined reads back as undefined', () => {
    const storage = memoryStorage({ k: '{"$olas":1,"v":2}' })
    const reader = mount(storage, { version: 2 })
    expect(reader.api.s.value).toBeUndefined()
    reader.dispose()
  })

  test('an undefined from a newer build is dropped, like any newer payload', () => {
    const storage = memoryStorage({ k: '{"$olas":1,"v":3}' })
    const reader = mount(storage, { version: 2, crossTab: true })
    expect(reader.api.s.value).toBe('default')
    reader.api.s.set('mine')
    storage.emitChange('k', '{"$olas":1,"v":3}')
    expect(reader.api.s.value).toBe('mine')
    reader.dispose()
  })

  test('a serialize that returns no string reports "serialize" and leaves storage alone', () => {
    const storage = memoryStorage({ k: JSON.stringify('kept') })
    const errors: PersistErrorOp[] = []
    const writer = mount(storage, {
      serialize: (value) =>
        value === 'unencodable' ? (undefined as unknown as string) : `${value}`,
      deserialize: (raw) => raw,
      onError: (_err, op) => errors.push(op),
    })
    writer.api.s.set('unencodable')
    expect(errors).toEqual(['serialize'])
    expect(storage.store.get('k')).toBe(JSON.stringify('kept'))
    writer.dispose()
  })
})
