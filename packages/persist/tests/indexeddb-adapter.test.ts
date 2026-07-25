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
//
// Transaction-aware: requests fire `onsuccess` first, then the TRANSACTION
// fires `oncomplete` on a later tick (or `onabort` on failure). This models the
// real commit lifecycle the adapter now relies on — a write is only "acked"
// once its transaction commits, so a commit failure (quota) surfaces as
// `tx.onabort`, not `req.onsuccess` (T6.1).

const tick = (fn: () => void): void => {
  Promise.resolve().then(fn)
}

const makeQuotaError = (): DOMException => {
  try {
    return new DOMException('Quota exceeded', 'QuotaExceededError')
  } catch {
    const e = new Error('Quota exceeded') as Error & { name: string }
    e.name = 'QuotaExceededError'
    return e as unknown as DOMException
  }
}

/** Failure injection for the fake IDB. */
type FailMode = {
  /** `put(key)` fires `req.onsuccess` but the transaction ABORTS at commit
   *  (models quota surfacing at commit time). */
  commitAbortKeys?: Set<string>
}

class FakeIdbRequest<T> {
  result: T | undefined
  error: DOMException | Error | null = null
  onsuccess: ((this: FakeIdbRequest<T>, ev: Event) => void) | null = null
  onerror: ((this: FakeIdbRequest<T>, ev: Event) => void) | null = null
  onupgradeneeded: ((this: FakeIdbRequest<T>, ev: Event) => void) | null = null
}

class FakeTransaction {
  error: DOMException | Error | null = null
  oncomplete: (() => void) | null = null
  onabort: (() => void) | null = null
  onerror: (() => void) | null = null
  private settled = false
  readonly store: FakeObjectStore
  constructor(map: Map<string, unknown>, fail: FailMode) {
    this.store = new FakeObjectStore(map, this, fail)
  }
  objectStore(): FakeObjectStore {
    return this.store
  }
  complete(): void {
    if (this.settled) return
    this.settled = true
    tick(() => this.oncomplete?.())
  }
  abort(err: DOMException | Error): void {
    if (this.settled) return
    this.settled = true
    this.error = err
    tick(() => this.onabort?.())
  }
}

class FakeObjectStore {
  constructor(
    private readonly map: Map<string, unknown>,
    private readonly tx: FakeTransaction,
    private readonly fail: FailMode,
  ) {}
  get(key: string): FakeIdbRequest<unknown> {
    const req = new FakeIdbRequest<unknown>()
    req.result = this.map.get(key)
    tick(() => {
      req.onsuccess?.call(req, new Event('success'))
      this.tx.complete()
    })
    return req
  }
  getAllKeys(): FakeIdbRequest<IDBValidKey[]> {
    const req = new FakeIdbRequest<IDBValidKey[]>()
    req.result = [...this.map.keys()]
    tick(() => {
      req.onsuccess?.call(req, new Event('success'))
      this.tx.complete()
    })
    return req
  }
  put(value: unknown, key: string): FakeIdbRequest<unknown> {
    const req = new FakeIdbRequest<unknown>()
    tick(() => {
      // Optimistic request-level success…
      this.map.set(key, value)
      req.result = key
      req.onsuccess?.call(req, new Event('success'))
      // …but the COMMIT may fail — roll back and abort the transaction.
      if (this.fail.commitAbortKeys?.has(key)) {
        this.map.delete(key)
        this.tx.abort(makeQuotaError())
      } else {
        this.tx.complete()
      }
    })
    return req
  }
  delete(key: string): FakeIdbRequest<unknown> {
    const req = new FakeIdbRequest<unknown>()
    tick(() => {
      this.map.delete(key)
      req.onsuccess?.call(req, new Event('success'))
      this.tx.complete()
    })
    return req
  }
}

class FakeIdbDatabase {
  readonly stores = new Map<string, Map<string, unknown>>()
  onversionchange: (() => void) | null = null
  private closed = false
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  }
  constructor(private readonly fail: FailMode) {}
  createObjectStore(name: string): void {
    this.stores.set(name, new Map<string, unknown>())
  }
  transaction(name: string, _mode: IDBTransactionMode): FakeTransaction {
    if (this.closed) {
      const e = new Error('db closed') as Error & { name: string }
      e.name = 'InvalidStateError'
      throw e
    }
    const m = this.stores.get(name)
    if (!m) throw new Error(`no store ${name}`)
    return new FakeTransaction(m, this.fail)
  }
  close(): void {
    this.closed = true
  }
}

const makeFakeIdb = (fail: FailMode = {}): IDBFactory => {
  const dbByName = new Map<string, FakeIdbDatabase>()
  return {
    open(name: string, _version?: number): IDBOpenDBRequest {
      const req = new FakeIdbRequest<FakeIdbDatabase>()
      const existing = dbByName.get(name)
      const isNew = existing === undefined
      const db = existing ?? new FakeIdbDatabase(fail)
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

// Each IDB op now resolves on the transaction's `oncomplete` (one more
// microtask hop than the old `req.onsuccess`), so drain generously.
const flush = async (n = 25): Promise<void> => {
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

describe('indexedDbAdapter — commit-ack + error routing (T6.1)', () => {
  test('set rejects when the transaction aborts at commit (not acked on req.onsuccess)', async () => {
    const idb = makeFakeIdb({ commitAbortKeys: new Set(['boom']) })
    const adapter = indexedDbAdapter({
      indexedDB: idb,
      broadcastChannel: makeFakeBroadcastChannel(),
    })
    // The request "succeeds" but the commit aborts — the adapter must reject,
    // not resolve (the old req.onsuccess-based code acked this write).
    await expect(adapter.set('boom', 'v')).rejects.toHaveProperty('name', 'QuotaExceededError')
    // A different key still commits normally; the aborted write didn't land.
    await adapter.set('ok', 'v')
    expect(await adapter.get('ok')).toBe('v')
    expect(await adapter.get('boom')).toBeNull()
  })

  test('a failing IDB write routes to usePersisted onError("write")', async () => {
    const idb = makeFakeIdb({ commitAbortKeys: new Set(['draft']) })
    const adapter = indexedDbAdapter({
      indexedDB: idb,
      broadcastChannel: makeFakeBroadcastChannel(),
    })
    const ops: string[] = []
    const def = defineController((ctx) => {
      const s = signal<string>('start')
      usePersisted(ctx, 'draft', s, { storage: adapter, onError: (_e, op) => ops.push(op) })
      return { s }
    })
    const root = createRoot(def, { deps: {} })
    await flush()
    root.s.set('will-fail')
    await flush()
    // Previously the adapter swallowed the rejection → onError never fired.
    expect(ops).toContain('write')
    root.dispose()
  })
})
