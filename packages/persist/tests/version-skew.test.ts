/**
 * `createPersisted` across builds that disagree on `version`. A tab on a
 * build without `version` must read what a newer build wrote with one, and
 * a user value that merely looks like an envelope must read back as itself,
 * whichever build reads it. Data an earlier version stored keeps reading as
 * it did.
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

/** Mount one persisted signal under `'k'`, as one build of the app would. */
function mount<T>(storage: StorageAdapter, initial: T, options: PersistOptions<T> = {}) {
  const def = defineController((ctx) => {
    const s = signal<T>(initial)
    createPersisted(ctx, 'k', s, { storage, ...options })
    return { s }
  })
  return createRoot(def, { queries: queryEngine(), deps: {} })
}

/** Write `value` under `'k'` the way a build with these options does. */
function writeWith<T>(storage: StorageAdapter, value: T, options: PersistOptions<T> = {}): string {
  const root = mount<T | undefined>(storage, undefined, options as PersistOptions<T | undefined>)
  root.api.s.set(value)
  root.dispose()
  return storage.get('k') as string
}

describe('a reader without version, and a value written with one', () => {
  test('on load, the envelope is unwrapped, not handed to deserialize', () => {
    const storage = memoryStorage()
    writeWith(storage, { theme: 'dark' }, { version: 2 })

    const old = mount(storage, { theme: 'light' })
    expect(old.api.s.value).toEqual({ theme: 'dark' })
    old.dispose()
  })

  test('across tabs, the envelope is unwrapped too', () => {
    const storage = memoryStorage()
    const old = mount(storage, 'initial', { crossTab: true })
    const newer = mount(storage, 'initial', { version: 2 })
    newer.api.s.set('from the newer build')
    storage.emitChange('k', storage.get('k') as string)

    expect(old.api.s.value).toBe('from the newer build')
    old.dispose()
    newer.dispose()
  })

  test('a build before 1.0, with version set, still reads the 1.0 envelope', () => {
    const storage = memoryStorage()
    const stored = writeWith(storage, 'hello', { version: 2 })
    // The check those builds ran: a numeric `v` and a string `d`.
    const parsed = JSON.parse(stored) as { v: unknown; d: unknown }
    expect(parsed.v).toBe(2)
    expect(parsed.d).toBe(JSON.stringify('hello'))
  })
})

describe('a value that looks like an envelope', () => {
  const lookalikes: Array<[string, unknown]> = [
    ['the envelope earlier versions wrote', { v: 1, d: 'x' }],
    ['the marked envelope', { $olas: 1, v: 3, d: '"z"' }],
    ['the marked wrapper for a raw value', { $olas: 1, d: '"z"' }],
    ['a marker with a version that is not a number', { $olas: 1, v: 'x', d: 'y' }],
    ['a `d` that is not a string', { v: 1, d: 1 }],
    ['a `d` with no version', { d: 'y' }],
  ]

  test.each(lookalikes)('%s reads back as itself without version', (_label, value) => {
    const storage = memoryStorage()
    writeWith<unknown>(storage, value)
    const reader = mount<unknown>(storage, 'default')
    expect(reader.api.s.value).toEqual(value)
    reader.dispose()
  })

  test.each(
    lookalikes,
  )('%s, written without version, is a raw value to a reader with one', (_label, value) => {
    const storage = memoryStorage()
    writeWith<unknown>(storage, value)
    const reader = mount<unknown>(storage, 'default', { version: 2 })
    expect(reader.api.s.value).toEqual(value)
    reader.dispose()
  })

  test('a migrator sees it as a raw payload from before versioning, not as an older envelope', async () => {
    const storage = memoryStorage()
    const value = { v: 1, d: 'x' }
    writeWith<unknown>(storage, value)
    const seen: Array<[string, number | undefined]> = []
    const reader = mount<unknown>(storage, 'default', {
      version: 2,
      migrate: (raw, from) => {
        seen.push([raw, from])
        return JSON.parse(raw)
      },
    })
    // `migrate` is awaited, so the migrated value lands a microtask later.
    await Promise.resolve()
    expect(seen).toEqual([[JSON.stringify(value), undefined]])
    expect(reader.api.s.value).toEqual(value)
    reader.dispose()
  })

  test('across tabs, it reads back as itself', () => {
    const storage = memoryStorage()
    const value = { v: 1, d: 'x' }
    const reader = mount<unknown>(storage, 'default', { crossTab: true })
    const versioned = mount<unknown>(storage, 'default', { crossTab: true, version: 2 })
    const raw = writeWith<unknown>(memoryStorage(), value)
    storage.emitChange('k', raw)
    expect(reader.api.s.value).toEqual(value)
    expect(versioned.api.s.value).toEqual(value)
    reader.dispose()
    versioned.dispose()
  })

  test('only a lookalike is wrapped: any other value is stored raw', () => {
    const storage = memoryStorage()
    expect(writeWith(storage, { theme: 'dark' })).toBe('{"theme":"dark"}')
    expect(writeWith(storage, { d: 'y', note: 'has a d' })).toBe('{"d":"y","note":"has a d"}')
    expect(writeWith(storage, 'plain')).toBe('"plain"')
  })
})

describe('data stored by an earlier version', () => {
  test('an envelope-shaped value stored raw stays whole for a reader without version', () => {
    const value = { v: 1, d: 'x' }
    const storage = memoryStorage({ k: JSON.stringify(value) })
    const reader = mount<unknown>(storage, 'default')
    expect(reader.api.s.value).toEqual(value)
    reader.dispose()
  })

  test('an unmarked envelope is still an envelope for a reader with version', () => {
    const storage = memoryStorage({ k: JSON.stringify({ v: 2, d: JSON.stringify('stored') }) })
    const reader = mount(storage, 'default', { version: 2 })
    expect(reader.api.s.value).toBe('stored')
    reader.dispose()
  })

  test('a corrupt payload that starts like an object still reports deserialize', () => {
    const storage = memoryStorage({ k: '{"d": not json' })
    const errors: PersistErrorOp[] = []
    const reader = mount(storage, 'default', { onError: (_err, op) => errors.push(op) })
    expect(errors).toEqual(['deserialize'])
    expect(reader.api.s.value).toBe('default')
    reader.dispose()
  })
})
