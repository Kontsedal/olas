/**
 * `createPersisted` writes on every change of its source. A signal calls a
 * new subscriber at once, inside `subscribe()`, with its current value, and
 * that call is not a change. Other sources do not call back on subscribe, and
 * their first call is a real change that must be written.
 */
import { createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { createPersisted, type PersistableSource, type StorageAdapter } from '../src'

const memoryStorage = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial))
  const writes: Array<[string, string]> = []
  const adapter: StorageAdapter = {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      writes.push([key, value])
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
  }
  return { adapter, store, writes }
}

/** A source that calls its subscribers on change only, like an event emitter. */
function changeOnlySource<T>(initial: T): PersistableSource<T> {
  let value = initial
  const handlers = new Set<(value: T) => void>()
  return {
    get value() {
      return value
    },
    set(next) {
      value = next
      for (const h of handlers) h(next)
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

function mount<T>(source: PersistableSource<T>, adapter: StorageAdapter) {
  const def = defineController((ctx) => {
    createPersisted(ctx, 'k', source, { storage: adapter })
    return {}
  })
  return createRoot(def, { queries: queryEngine(), deps: {} })
}

describe('createPersisted — the first delivery of a source', () => {
  test('a source that does not call back on subscribe keeps its first change', () => {
    const storage = memoryStorage()
    const source = changeOnlySource(0)
    const root = mount(source, storage.adapter)
    expect(storage.writes).toEqual([])

    source.set(1)
    expect(storage.writes).toEqual([['k', '1']])
    source.set(2)
    expect(storage.writes).toEqual([
      ['k', '1'],
      ['k', '2'],
    ])
    root.dispose()
  })

  test('its stored value still loads, and is not written back', () => {
    const storage = memoryStorage({ k: '7' })
    const source = changeOnlySource(0)
    const root = mount(source, storage.adapter)
    expect(source.value).toBe(7)
    expect(storage.writes).toEqual([])
    root.dispose()
  })

  test('a signal calls back inside subscribe; that call is not written, the next change is', () => {
    const storage = memoryStorage()
    const s = signal(0)
    const root = mount(s, storage.adapter)
    expect(storage.writes).toEqual([])

    s.set(1)
    expect(storage.writes).toEqual([['k', '1']])
    root.dispose()
  })

  test('a signal loaded from storage does not write the loaded value back', () => {
    const storage = memoryStorage({ k: '7' })
    const s = signal(0)
    const root = mount(s, storage.adapter)
    expect(s.value).toBe(7)
    expect(storage.writes).toEqual([])
    root.dispose()
  })
})
