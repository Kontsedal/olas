import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
import { signal } from '@kontsedal/olas-core'

export type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  delete(key: string): void | Promise<void>
  onChange?(handler: (key: string, value: string | null) => void): () => void
  /**
   * Optional — list every key currently in storage. Consumers that need to
   * enumerate keys (e.g. `@kontsedal/olas-mutation-queue` replaying the
   * pending queue on init) require this extension; consumers that only
   * `get` / `set` known keys (the typical `usePersisted` shape) don't need
   * it. Both built-in adapters (`localStorageAdapter`, `indexedDbAdapter`)
   * implement it.
   */
  keys?(): Iterable<string> | Promise<Iterable<string>>
}

export type PersistOptions<T> = {
  /**
   * Storage backend. When omitted *or explicitly `undefined`* (handy for app
   * code that forwards a deps slot like `ctx.deps.storage`), the browser
   * `localStorageAdapter` is used. SSR-safe — `localStorageAdapter` no-ops
   * when `localStorage` isn't defined.
   */
  storage?: StorageAdapter | undefined
  serialize?: (value: T) => string
  deserialize?: (raw: string) => T
  crossTab?: boolean
}

export type Persisted = {
  ready: ReadSignal<boolean>
}

export type PersistableSource<T> = {
  readonly value: T
  set(value: T): void
  subscribe(handler: (value: T) => void): () => void
}

/**
 * Configuration for `indexedDbAdapter`. All fields optional; sane defaults
 * picked for typical app use.
 */
export type IndexedDbAdapterOptions = {
  /** Database name. Defaults to `'olas-persist'`. */
  databaseName?: string
  /** Object store inside the database. Defaults to `'kv'`. */
  storeName?: string
  /**
   * `BroadcastChannel` name used to notify other tabs of writes through this
   * adapter (so `onChange` works cross-tab — IDB itself has no built-in
   * change event). Defaults to `'olas-persist:' + databaseName + '/' +
   * storeName`. Set to `null` to disable cross-tab notifications.
   */
  channelName?: string | null
  /**
   * Override the `IDBFactory` — defaults to `globalThis.indexedDB`. Useful
   * for testing (inject a fake) or runtimes that ship their own IDB
   * implementation. When undefined and no global `indexedDB`, the adapter
   * no-ops (SSR-safe).
   */
  indexedDB?: IDBFactory
  /**
   * Override the `BroadcastChannel` constructor. Defaults to
   * `globalThis.BroadcastChannel`. When undefined and no global, `onChange`
   * subscriptions still register but never fire.
   */
  broadcastChannel?: typeof BroadcastChannel
}

/**
 * IndexedDB-backed `StorageAdapter`. Async on every operation; cross-tab
 * change notifications layered via `BroadcastChannel` (IDB has no native
 * change event, so external IDB writes by code that doesn't go through
 * this adapter are *not* observed). When no `IDBFactory` is available
 * (SSR, restricted environments), every method resolves to a no-op.
 *
 * Storage is a single key/value object store inside a single database;
 * fine for the persisted-signal use case `usePersisted` is built around.
 * For larger or schema-shaped data, write a custom adapter against your
 * own IDB layout.
 */
export function indexedDbAdapter(options?: IndexedDbAdapterOptions): StorageAdapter {
  const dbName = options?.databaseName ?? 'olas-persist'
  const storeName = options?.storeName ?? 'kv'
  const idbFactory = options?.indexedDB ?? getGlobalIndexedDb()
  const bcCtor = options?.broadcastChannel ?? getGlobalBroadcastChannel()
  const channelName =
    options?.channelName === null
      ? null
      : (options?.channelName ?? `olas-persist:${dbName}/${storeName}`)

  let dbPromise: Promise<IDBDatabase> | null = null
  let channel: BroadcastChannel | null = null

  const ensureChannel = (): BroadcastChannel | null => {
    if (channel !== null) return channel
    if (bcCtor === undefined || channelName === null) return null
    try {
      channel = new bcCtor(channelName)
      return channel
    } catch {
      return null
    }
  }

  const openDb = (): Promise<IDBDatabase> | null => {
    if (idbFactory === undefined) return null
    if (dbPromise !== null) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idbFactory.open(dbName, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('[olas-persist] IDB open failed'))
    })
    // Lazy connection — if the open fails, future calls retry rather than
    // staying stuck on a poisoned promise.
    dbPromise.catch(() => {
      dbPromise = null
    })
    return dbPromise
  }

  const runRequest = async <T>(
    mode: IDBTransactionMode,
    build: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | undefined> => {
    const db = await openDb()
    if (db === null) return undefined
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const store = tx.objectStore(storeName)
      const req = build(store)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('[olas-persist] IDB request failed'))
    })
  }

  return {
    async get(key: string): Promise<string | null> {
      if (idbFactory === undefined) return null
      try {
        const result = await runRequest<unknown>('readonly', (s) => s.get(key))
        return typeof result === 'string' ? result : null
      } catch {
        return null
      }
    },
    async set(key: string, value: string): Promise<void> {
      if (idbFactory === undefined) return
      try {
        await runRequest('readwrite', (s) => s.put(value, key))
        ensureChannel()?.postMessage({ key, value })
      } catch {
        // Quota / version / closed-db errors — leave to caller's higher-level
        // handling; persist's usePersisted swallows write rejections too.
      }
    },
    async delete(key: string): Promise<void> {
      if (idbFactory === undefined) return
      try {
        await runRequest('readwrite', (s) => s.delete(key))
        ensureChannel()?.postMessage({ key, value: null })
      } catch {
        /* swallow — see set() */
      }
    },
    onChange(handler: (key: string, value: string | null) => void): () => void {
      const ch = ensureChannel()
      if (ch === null) return () => {}
      const listener = (event: MessageEvent<{ key: string; value: string | null }>) => {
        try {
          handler(event.data.key, event.data.value)
        } catch {
          /* swallow — onChange handlers shouldn't take down the adapter */
        }
      }
      ch.addEventListener('message', listener)
      return () => ch.removeEventListener('message', listener)
    },
    async keys(): Promise<string[]> {
      if (idbFactory === undefined) return []
      try {
        const result = await runRequest<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
        if (!Array.isArray(result)) return []
        return result.filter((k): k is string => typeof k === 'string')
      } catch {
        return []
      }
    },
  }
}

function getGlobalIndexedDb(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB
}

function getGlobalBroadcastChannel(): typeof BroadcastChannel | undefined {
  return typeof BroadcastChannel === 'undefined' ? undefined : BroadcastChannel
}

/** Default localStorage adapter — only viable in the browser. */
export const localStorageAdapter: StorageAdapter = {
  get(key: string): string | null {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  },
  set(key: string, value: string): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  },
  delete(key: string): void {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  },
  onChange(handler) {
    if (typeof window === 'undefined') return () => {}
    const listener = (event: StorageEvent) => {
      if (event.key === null) return
      handler(event.key, event.newValue)
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  },
  keys(): string[] {
    if (typeof localStorage === 'undefined') return []
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null) out.push(k)
    }
    return out
  },
}

/**
 * Persist a signal-like source under `key`. Loads the stored value on
 * construction (sync for localStorage, async for any storage that returns a
 * promise). Subsequent writes to the source are mirrored to storage.
 *
 * Cleanup (unsubscribe + cross-tab listener removal) is bound to `ctx`.
 */
export function usePersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,
  options?: PersistOptions<T>,
): Persisted {
  const storage = options?.storage ?? localStorageAdapter
  const serialize = options?.serialize ?? JSON.stringify
  const deserialize = options?.deserialize ?? JSON.parse
  const crossTab = options?.crossTab ?? false

  const ready$ = signal(false)
  let writingFromLoad = false

  // Load initial value.
  const loaded = storage.get(key)
  const applyLoaded = (raw: string | null) => {
    if (raw == null) {
      ready$.set(true)
      return
    }
    try {
      const value = deserialize(raw)
      writingFromLoad = true
      try {
        source.set(value)
      } finally {
        writingFromLoad = false
      }
    } catch {
      // Corrupted entry — ignore and continue with whatever the source had.
    }
    ready$.set(true)
  }

  if (loaded instanceof Promise) {
    loaded.then(applyLoaded, () => ready$.set(true))
  } else {
    applyLoaded(loaded)
  }

  // Persist on every CHANGE. The signal's subscribe fires immediately with
  // the current value — skip that initial call so we don't write back what
  // we just loaded (or the source's default before load).
  let skipFirstDelivery = true
  const unsub = source.subscribe((value) => {
    if (skipFirstDelivery) {
      skipFirstDelivery = false
      return
    }
    if (writingFromLoad) return
    if (!ready$.peek()) return
    try {
      const raw = serialize(value)
      const writeResult = storage.set(key, raw)
      if (writeResult instanceof Promise) {
        writeResult.catch(() => {
          /* swallow write errors — caller can supply onError via deps if they care */
        })
      }
    } catch {
      // Serialization failed; nothing to do.
    }
  })

  // Cross-tab sync.
  let unsubChange: (() => void) | null = null
  if (crossTab && storage.onChange) {
    unsubChange = storage.onChange((changedKey, rawValue) => {
      if (changedKey !== key) return
      // Storage delete in another tab (`localStorage.removeItem`) arrives as
      // `rawValue == null`. Mirror the delete locally by writing `undefined`
      // through to source — consumers whose `T` doesn't include `undefined`
      // should treat that as "value gone, fall back to initial."
      if (rawValue == null) {
        writingFromLoad = true
        try {
          source.set(undefined as T)
        } finally {
          writingFromLoad = false
        }
        return
      }
      try {
        const value = deserialize(rawValue)
        writingFromLoad = true
        try {
          source.set(value)
        } finally {
          writingFromLoad = false
        }
      } catch {
        /* ignore */
      }
    })
  }

  ctx.onDispose(() => {
    unsub()
    unsubChange?.()
  })

  return { ready: ready$ }
}
