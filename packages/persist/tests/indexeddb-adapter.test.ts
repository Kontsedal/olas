/**
 * Tests for the IndexedDB adapter. We don't depend on a real IDB; the
 * adapter accepts an `indexedDB` override, and this file ships a tiny
 * in-memory `IDBFactory` mock that implements only the surface the adapter
 * exercises (open + put / get / delete + onsuccess/onerror).
 *
 * For cross-tab onChange, we likewise plug a `BroadcastChannel` shim — node
 * 18+ ships a global one, but the adapter's `broadcastChannel` option lets
 * us route both endpoints through one in-test instance.
 */
import { createRoot, defineController, signal } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { type IndexedDbAdapterOptions, indexedDbAdapter, usePersisted } from '../src'

// ─── Minimal in-memory IDB ──────────────────────────────────────────────────

const tick = (fn: () => void): void => {
  Promise.resolve().then(fn)
}

class FakeIdbRequest<T> {
  result: T | undefined
  error: Error | null = null
  onsuccess: ((this: FakeIdbRequest<T>, ev: Event) => void) | null = null
  onerror: ((this: FakeIdbRequest<T>, ev: Event) => void) | null = null
  // Used by IDBOpenDBRequest:
  onupgradeneeded: ((this: FakeIdbRequest<T>, ev: Event) => void) | null = null
}

class FakeObjectStore {
  // biome-ignore lint/suspicious/noExplicitAny: in-memory store
  private readonly map: Map<string, any>
  // biome-ignore lint/suspicious/noExplicitAny: in-memory store
  constructor(map: Map<string, any>) {
    this.map = map
  }
  get(key: string): FakeIdbRequest<unknown> {
    const req = new FakeIdbRequest<unknown>()
    req.result = this.map.get(key)
    tick(() => req.onsuccess?.call(req, new Event('success')))
    return req
  }
  put(value: unknown, key: string): FakeIdbRequest<unknown> {
    const req = new FakeIdbRequest<unknown>()
    this.map.set(key, value)
    req.result = key
    tick(() => req.onsuccess?.call(req, new Event('success')))
    return req
  }
  delete(key: string): FakeIdbRequest<unknown> {
    const req = new FakeIdbRequest<unknown>()
    this.map.delete(key)
    tick(() => req.onsuccess?.call(req, new Event('success')))
    return req
  }
}

class FakeIdbDatabase {
  // biome-ignore lint/suspicious/noExplicitAny: in-memory store
  readonly stores = new Map<string, Map<string, any>>()
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  }
  createObjectStore(name: string): FakeObjectStore {
    const map = new Map<string, unknown>()
    this.stores.set(name, map)
    return new FakeObjectStore(map)
  }
  transaction(
    name: string,
    _mode: IDBTransactionMode,
  ): { objectStore: (n: string) => FakeObjectStore } {
    return {
      objectStore: (n: string) => {
        const m = this.stores.get(n)
        if (!m) throw new Error(`no store ${n}`)
        return new FakeObjectStore(m)
      },
    }
  }
}

const makeFakeIdb = (): IDBFactory => {
  const dbByName = new Map<string, FakeIdbDatabase>()
  return {
    open(name: string, _version?: number): IDBOpenDBRequest {
      const req = new FakeIdbRequest<FakeIdbDatabase>()
      const existing = dbByName.get(name)
      const isNew = existing === undefined
      const db = existing ?? new FakeIdbDatabase()
      dbByName.set(name, db)
      req.result = db
      tick(() => {
        if (isNew) {
          // Simulate the upgrade phase running first.
          req.onupgradeneeded?.call(req, new Event('upgradeneeded'))
        }
        req.onsuccess?.call(req, new Event('success'))
      })
      return req as unknown as IDBOpenDBRequest
    },
  } as unknown as IDBFactory
}

// ─── Minimal in-memory BroadcastChannel ─────────────────────────────────────

const makeFakeBroadcastChannel = (): typeof BroadcastChannel => {
  const buses = new Map<string, Set<FakeChannel>>()
  class FakeChannel extends EventTarget {
    readonly name: string
    constructor(name: string) {
      super()
      this.name = name
      let bus = buses.get(name)
      if (!bus) {
        bus = new Set()
        buses.set(name, bus)
      }
      bus.add(this)
    }
    postMessage(data: unknown): void {
      const bus = buses.get(this.name)
      if (!bus) return
      for (const peer of bus) {
        if (peer === this) continue
        // Mirror the standard: dispatch on a microtask.
        tick(() => peer.dispatchEvent(new MessageEvent('message', { data })))
      }
    }
    close(): void {
      buses.get(this.name)?.delete(this)
    }
  }
  return FakeChannel as unknown as typeof BroadcastChannel
}

const flush = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('indexedDbAdapter — shape + SSR-safe', () => {
  test('returns a StorageAdapter with the documented surface', () => {
    const adapter = indexedDbAdapter({ indexedDB: makeFakeIdb() })
    expect(typeof adapter.get).toBe('function')
    expect(typeof adapter.set).toBe('function')
    expect(typeof adapter.delete).toBe('function')
    expect(typeof adapter.onChange).toBe('function')
  })

  test('no global IDB: every operation resolves to null/void without throwing', async () => {
    // No `indexedDB` override and no global → all ops are no-ops.
    const adapter = indexedDbAdapter()
    // jsdom may provide one; only assert when no global exists.
    if (typeof indexedDB !== 'undefined') return
    expect(await adapter.get('k')).toBeNull()
    await adapter.set('k', 'v')
    await adapter.delete('k')
    const off = adapter.onChange?.(() => {})
    expect(off).toBeDefined()
    off?.()
  })
})

describe('indexedDbAdapter — round-trip', () => {
  test('set then get returns the stored value', async () => {
    const adapter = indexedDbAdapter({
      indexedDB: makeFakeIdb(),
      broadcastChannel: makeFakeBroadcastChannel(),
    })
    await adapter.set('k', 'value-1')
    const v = await adapter.get('k')
    expect(v).toBe('value-1')
  })

  test('delete removes the key; subsequent get returns null', async () => {
    const adapter = indexedDbAdapter({
      indexedDB: makeFakeIdb(),
      broadcastChannel: makeFakeBroadcastChannel(),
    })
    await adapter.set('k', 'gone')
    await adapter.delete('k')
    expect(await adapter.get('k')).toBeNull()
  })

  test('get of a missing key returns null', async () => {
    const adapter = indexedDbAdapter({
      indexedDB: makeFakeIdb(),
      broadcastChannel: makeFakeBroadcastChannel(),
    })
    expect(await adapter.get('never-set')).toBeNull()
  })
})

describe('indexedDbAdapter — cross-tab onChange', () => {
  test('write in one adapter fires onChange in a sibling adapter on the same channel', async () => {
    // Share the IDBFactory + BC implementation across two adapter instances —
    // models two tabs of the same origin.
    const idb = makeFakeIdb()
    const bc = makeFakeBroadcastChannel()
    const baseOpts: IndexedDbAdapterOptions = {
      indexedDB: idb,
      broadcastChannel: bc,
      channelName: 'shared-channel',
    }
    const a = indexedDbAdapter(baseOpts)
    const b = indexedDbAdapter(baseOpts)

    const seenByB: Array<[string, string | null]> = []
    const off = b.onChange!((k, v) => seenByB.push([k, v]))

    await a.set('k', 'hello')
    await flush()
    expect(seenByB).toEqual([['k', 'hello']])

    await a.delete('k')
    await flush()
    expect(seenByB).toEqual([
      ['k', 'hello'],
      ['k', null],
    ])

    off()
    // After unsubscribe, further writes don't show up.
    await a.set('k', 'after-off')
    await flush()
    expect(seenByB).toHaveLength(2)
  })

  test('channelName=null disables cross-tab broadcasting; onChange returns a no-op', async () => {
    const idb = makeFakeIdb()
    const bc = makeFakeBroadcastChannel()
    const adapter = indexedDbAdapter({
      indexedDB: idb,
      broadcastChannel: bc,
      channelName: null,
    })
    const seen: unknown[] = []
    const off = adapter.onChange!((k, v) => seen.push([k, v]))
    await adapter.set('k', 'v')
    await flush()
    expect(seen).toEqual([])
    off()
  })
})

describe('indexedDbAdapter — integration with usePersisted', () => {
  test('persists a signal to IDB and reloads it on a fresh root', async () => {
    const idb = makeFakeIdb()
    const adapter = indexedDbAdapter({
      indexedDB: idb,
      broadcastChannel: makeFakeBroadcastChannel(),
    })

    const defWrite = defineController((ctx) => {
      const s = signal<string>('initial')
      const p = usePersisted(ctx, 'draft', s, { storage: adapter })
      return { s, ready: p.ready }
    })
    const r1 = createRoot(defWrite, { deps: {} })
    await flush()
    expect(r1.ready.value).toBe(true)
    r1.s.set('saved-value')
    await flush()
    r1.dispose()

    // Fresh adapter on the same IDB → should observe persisted value.
    const adapter2 = indexedDbAdapter({
      indexedDB: idb,
      broadcastChannel: makeFakeBroadcastChannel(),
    })
    const defRead = defineController((ctx) => {
      const s = signal<string>('default-if-missing')
      const p = usePersisted(ctx, 'draft', s, { storage: adapter2 })
      return { s, ready: p.ready }
    })
    const r2 = createRoot(defRead, { deps: {} })
    await flush()
    expect(r2.ready.value).toBe(true)
    expect(r2.s.value).toBe('saved-value')
    r2.dispose()
  })

  test('crossTab=true picks up writes from a sibling adapter', async () => {
    const idb = makeFakeIdb()
    const bc = makeFakeBroadcastChannel()
    const baseOpts: IndexedDbAdapterOptions = {
      indexedDB: idb,
      broadcastChannel: bc,
      channelName: 'cross-tab-test',
    }
    const tabA = indexedDbAdapter(baseOpts)
    const tabB = indexedDbAdapter(baseOpts)

    // Tab B holds a persisted signal listening for cross-tab updates.
    const def = defineController((ctx) => {
      const s = signal<string>('')
      usePersisted(ctx, 'k', s, { storage: tabB, crossTab: true })
      return { s }
    })
    const root = createRoot(def, { deps: {} })
    await flush()

    await tabA.set('k', JSON.stringify('hello-from-A'))
    await flush()
    expect(root.s.value).toBe('hello-from-A')

    root.dispose()
  })
})
