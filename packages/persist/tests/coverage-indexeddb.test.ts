/**
 * `indexedDbAdapter` failure paths: a failed open and its retry, a
 * `versionchange` from another tab, request errors that bubble to the
 * transaction, an abort without an error, `keys()`, and the global
 * `indexedDB` / `BroadcastChannel` lookups.
 *
 * The fake models the real IDB event order: a request error fires the
 * request's `onerror`, then bubbles to the transaction's `onerror`, then the
 * transaction aborts. Every event lands on a later microtask.
 */
import { createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createPersisted, indexedDbAdapter } from '../src'

const tick = (fn: () => void): void => {
  Promise.resolve().then(fn)
}

const flush = async (n = 25): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

type Op = 'get' | 'put' | 'delete' | 'getAllKeys'
/** How one request ends. */
type Outcome = 'ok' | 'request-error' | 'abort-without-error'

type FakeOptions = {
  /** Fail the first N `open()` calls. */
  failOpens?: number
  /** The `error` a failed open carries. `null` models a browser that sets none. */
  openError?: Error | null
  outcome?: (op: Op, key: string | undefined) => Outcome
}

class FakeRequest {
  result: unknown
  error: Error | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: (() => void) | null = null
}

class FakeTransaction {
  error: Error | null = null
  oncomplete: (() => void) | null = null
  onabort: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(
    private readonly map: Map<unknown, unknown>,
    private readonly outcome: (op: Op, key: string | undefined) => Outcome,
  ) {}
  objectStore(): Record<Op, (...args: never[]) => FakeRequest> {
    const run = (op: Op, key: string | undefined, apply: (req: FakeRequest) => void) => {
      const req = new FakeRequest()
      tick(() => {
        const outcome = this.outcome(op, key)
        if (outcome === 'request-error') {
          req.error = new Error(`${op} failed`)
          req.onerror?.()
          // The error event bubbles to the transaction, which then aborts.
          this.error = req.error
          this.onerror?.()
          this.onabort?.()
          return
        }
        apply(req)
        req.onsuccess?.()
        if (outcome === 'abort-without-error') {
          // `transaction.abort()` called explicitly: `error` stays null.
          this.onabort?.()
          return
        }
        this.oncomplete?.()
      })
      return req
    }
    return {
      get: (key: string) =>
        run('get', key, (req) => {
          req.result = this.map.get(key)
        }),
      put: (value: unknown, key: string) =>
        run('put', key, () => {
          this.map.set(key, value)
        }),
      delete: (key: string) =>
        run('delete', key, () => {
          this.map.delete(key)
        }),
      getAllKeys: () =>
        run('getAllKeys', undefined, (req) => {
          req.result = [...this.map.keys()]
        }),
    }
  }
}

class FakeDatabase {
  closed = false
  onversionchange: (() => void) | null = null
  readonly stores = new Map<string, Map<unknown, unknown>>()
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) }
  constructor(private readonly outcome: (op: Op, key: string | undefined) => Outcome) {}
  createObjectStore(name: string): void {
    this.stores.set(name, new Map())
  }
  transaction(name: string): FakeTransaction {
    if (this.closed) throw new Error('InvalidStateError: the connection is closed')
    const map = this.stores.get(name)
    if (map === undefined) throw new Error(`no store ${name}`)
    return new FakeTransaction(map, this.outcome)
  }
  close(): void {
    this.closed = true
  }
}

const makeFakeIdb = (options: FakeOptions = {}) => {
  const outcome = options.outcome ?? (() => 'ok' as const)
  let failuresLeft = options.failOpens ?? 0
  const connections: FakeDatabase[] = []
  /** One backing map per store name, shared by every connection. */
  const data = new Map<string, Map<unknown, unknown>>()
  const factory = {
    open(): FakeRequest {
      const req = new FakeRequest()
      tick(() => {
        if (failuresLeft > 0) {
          failuresLeft--
          req.error =
            options.openError === undefined ? new Error('open refused') : options.openError
          req.onerror?.()
          return
        }
        const db = new FakeDatabase(outcome)
        for (const [name, map] of data) db.stores.set(name, map)
        req.result = db
        req.onupgradeneeded?.()
        for (const [name, map] of db.stores) data.set(name, map)
        connections.push(db)
        req.onsuccess?.()
      })
      return req
    },
  }
  return {
    factory: factory as unknown as IDBFactory,
    connections,
    store: (name = 'kv') => data.get(name),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('indexedDbAdapter — opening the database', () => {
  test('a failed open rejects with its error, and the next call opens again', async () => {
    const idb = makeFakeIdb({ failOpens: 1 })
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    await expect(adapter.get('k')).rejects.toThrow('open refused')
    // The poisoned promise was dropped: this call re-opens and succeeds.
    await adapter.set('k', 'v')
    expect(await adapter.get('k')).toBe('v')
    expect(idb.connections).toHaveLength(1)
  })

  test('an open failure with no error object rejects with a descriptive Error', async () => {
    const idb = makeFakeIdb({ failOpens: 1, openError: null })
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    await expect(adapter.get('k')).rejects.toThrow('[olas-persist] IDB open failed')
  })

  test('a versionchange from another tab closes the connection; the next op re-opens', async () => {
    const idb = makeFakeIdb()
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    await adapter.set('k', 'v1')
    expect(idb.connections).toHaveLength(1)

    const first = idb.connections[0] as FakeDatabase
    first.onversionchange?.()
    expect(first.closed).toBe(true)

    // Without the reset this would hit the closed connection and throw.
    expect(await adapter.get('k')).toBe('v1')
    expect(idb.connections).toHaveLength(2)
  })

  test('with no `indexedDB` option the adapter uses the global one', async () => {
    const idb = makeFakeIdb()
    vi.stubGlobal('indexedDB', idb.factory)
    const adapter = indexedDbAdapter({ channelName: null })
    await adapter.set('k', 'global')
    expect(await adapter.get('k')).toBe('global')
    expect(idb.store()?.get('k')).toBe('global')
  })
})

describe('indexedDbAdapter — request and transaction failures', () => {
  test('a request error rejects with the request error, once', async () => {
    const idb = makeFakeIdb({ outcome: (op) => (op === 'get' ? 'request-error' : 'ok') })
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    // req.onerror, tx.onerror and tx.onabort all fire; the first one settles.
    await expect(adapter.get('k')).rejects.toThrow('get failed')
  })

  test('a delete whose request fails rejects and leaves the key in place', async () => {
    const idb = makeFakeIdb({ outcome: (op) => (op === 'delete' ? 'request-error' : 'ok') })
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    await adapter.set('k', 'kept')
    await expect(adapter.delete('k')).rejects.toThrow('delete failed')
    expect(await adapter.get('k')).toBe('kept')
  })

  test('an abort that carries no error rejects with a descriptive Error', async () => {
    const idb = makeFakeIdb({
      outcome: (op) => (op === 'put' ? 'abort-without-error' : 'ok'),
    })
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    await expect(adapter.set('k', 'v')).rejects.toThrow('[olas-persist] IDB request failed')
  })

  test('a failing read routes to createPersisted onError("load") and still flips ready', async () => {
    const idb = makeFakeIdb({ outcome: (op) => (op === 'get' ? 'request-error' : 'ok') })
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    const ops: string[] = []
    const def = defineController((ctx) => {
      const s = signal<string>('default')
      const p = createPersisted(ctx, 'draft', s, {
        storage: adapter,
        onError: (_e, op) => ops.push(op),
      })
      return { s, ready: p.ready }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    await flush()
    expect(ops).toEqual(['load'])
    expect(root.api.ready.value).toBe(true)
    expect(root.api.s.value).toBe('default')
    root.dispose()
  })
})

describe('indexedDbAdapter — keys()', () => {
  test('lists the string keys in the store, skipping non-string ones', async () => {
    const idb = makeFakeIdb()
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    await adapter.set('a', '1')
    await adapter.set('b', '2')
    // A key written by other code on the same store, not through the adapter.
    idb.store()?.set(42, 'numeric')
    expect(await adapter.keys?.()).toEqual(['a', 'b'])
  })

  test('a failed enumeration resolves to an empty list', async () => {
    const idb = makeFakeIdb({ outcome: (op) => (op === 'getAllKeys' ? 'request-error' : 'ok') })
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, channelName: null })
    await adapter.set('a', '1')
    expect(await adapter.keys?.()).toEqual([])
  })

  test('with no IDB anywhere, keys() resolves to an empty list', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const adapter = indexedDbAdapter()
    expect(await adapter.keys?.()).toEqual([])
  })
})

describe('indexedDbAdapter — BroadcastChannel availability', () => {
  test('a BroadcastChannel constructor that throws disables onChange; writes still land', async () => {
    const idb = makeFakeIdb()
    const Throwing = function ThrowingChannel() {
      throw new Error('BroadcastChannel is blocked')
    } as unknown as typeof BroadcastChannel
    const adapter = indexedDbAdapter({ indexedDB: idb.factory, broadcastChannel: Throwing })
    const handler = vi.fn()
    const off = adapter.onChange?.(handler)
    expect(typeof off).toBe('function')
    off?.()
    await adapter.set('k', 'v')
    expect(await adapter.get('k')).toBe('v')
    expect(handler).not.toHaveBeenCalled()
  })

  test('with no global BroadcastChannel, writes are not broadcast to a sibling adapter', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const idb = makeFakeIdb()
    const writer = indexedDbAdapter({ indexedDB: idb.factory })
    const reader = indexedDbAdapter({ indexedDB: idb.factory })
    const handler = vi.fn()
    const off = reader.onChange?.(handler)
    await writer.set('k', 'v')
    await flush()
    expect(handler).not.toHaveBeenCalled()
    // The write itself landed in the shared store.
    expect(await reader.get('k')).toBe('v')
    off?.()
  })
})
