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

/**
 * Where a `PersistOptions.onError` fired. Distinguishes the failing operation
 * for routing (e.g. quota-exceeded vs schema-migration-failed vs
 * deserialization-corrupted).
 */
export type PersistErrorOp =
  | 'load'
  | 'deserialize'
  | 'serialize'
  | 'write'
  | 'migrate'
  | 'remoteChange'

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
  /**
   * Schema version. When the value loaded from storage carries a different
   * `version`, `migrate(raw, fromVersion)` is invoked to bring it forward;
   * the migrated value is written back atomically. When omitted, no version
   * gate runs — payloads are read and written raw (current default).
   *
   * The on-disk shape with versioning enabled is `{"v": N, "d": <serialized>}`
   * — `usePersisted` wraps every write and reads both shapes (legacy raw and
   * versioned). Versioned writes only happen once `version` is set.
   */
  version?: number
  /**
   * Migrate a raw payload of a prior version. Receives the pre-deserialize
   * string and the version number it was written with (or `undefined` if no
   * version stamp existed, i.e. the legacy raw shape). Return the migrated
   * payload AS A `T` value (post-deserialize); `usePersisted` re-serializes
   * it before writing. Return `undefined` to drop the entry (the source
   * keeps its current value).
   */
  migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<T | undefined>
  /**
   * Debounce writes by `throttleMs` milliseconds. Useful for high-frequency
   * sources (cursor position, scroll, every-keystroke field) where the
   * default "write on every change" is too chatty. Defaults to `0` (no
   * debounce). On `ctx.onDispose`, any pending write is flushed.
   */
  throttleMs?: number
  /**
   * Routed errors from every fallible op: storage `get`/`set` (quota,
   * security, version-conflict), `deserialize`/`serialize` (corrupt JSON,
   * non-serializable T), `migrate` (user-thrown), and `onChange` callbacks
   * (cross-tab payload corruption). Without this, errors are swallowed —
   * matches the historical behavior, but production apps want at least a
   * sentry/console hook.
   */
  onError?: (err: unknown, op: PersistErrorOp, key: string) => void
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
      req.onsuccess = () => {
        const db = req.result
        // Without this, holding the connection open BLOCKS another tab that
        // wants to upgrade or `deleteDatabase` — a permanent silent stall.
        // Close ours and drop the cached promise so the next op re-opens; a
        // failed re-open then REJECTS and routes through the caller's onError
        // instead of no-oping forever (T6.1).
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
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
      let settled = false
      const fail = (err: unknown): void => {
        if (settled) return
        settled = true
        reject(err ?? new Error('[olas-persist] IDB request failed'))
      }
      const tx = db.transaction(storeName, mode)
      const store = tx.objectStore(storeName)
      const req = build(store)
      let result: T | undefined
      // Capture the request's result on success, but resolve on the
      // TRANSACTION's commit — a write's `req.onsuccess` fires before the data
      // is durably committed, so quota / disk failures only surface as a
      // `tx.onabort` at commit time. Resolving on `req.onsuccess` (the old
      // behavior) acked writes that never landed (T6.1).
      req.onsuccess = () => {
        result = req.result
      }
      req.onerror = () => fail(req.error)
      tx.oncomplete = () => {
        if (settled) return
        settled = true
        resolve(result)
      }
      tx.onabort = () => fail(tx.error)
      tx.onerror = () => fail(tx.error)
    })
  }

  return {
    async get(key: string): Promise<string | null> {
      if (idbFactory === undefined) return null
      // A real read error (db closed, corrupt store) REJECTS so the caller's
      // error routing runs (`usePersisted` → `onError('load')`). A missing key
      // is not an error — `req.result` is `undefined`, so we return null.
      const result = await runRequest<unknown>('readonly', (s) => s.get(key))
      return typeof result === 'string' ? result : null
    },
    async set(key: string, value: string): Promise<void> {
      if (idbFactory === undefined) return
      // Do NOT swallow — a rejected write (quota, closed db, aborted commit)
      // propagates so `usePersisted`'s `onError('write')` fires (T6.1). The
      // cross-tab broadcast only runs once the commit actually lands.
      await runRequest('readwrite', (s) => s.put(value, key))
      ensureChannel()?.postMessage({ key, value })
    },
    async delete(key: string): Promise<void> {
      if (idbFactory === undefined) return
      await runRequest('readwrite', (s) => s.delete(key))
      ensureChannel()?.postMessage({ key, value: null })
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
  const version = options?.version
  const migrate = options?.migrate
  const throttleMs = options?.throttleMs ?? 0
  const onError = options?.onError

  const reportError = (err: unknown, op: PersistErrorOp): void => {
    if (onError === undefined) return
    try {
      onError(err, op, key)
    } catch {
      /* an onError handler that itself throws is its own problem. */
    }
  }

  const ready$ = signal(false)
  let writingFromLoad = false
  // Ready-gate race bookkeeping (T6.1). A source write or a cross-tab change
  // that lands BEFORE the initial async load settles must not be lost or
  // clobbered by `applyLoaded`. We remember the latest of each and reconcile
  // once ready flips true (a local user write wins over both stored + remote).
  let userWroteBeforeReady = false
  let pendingUserValueBeforeReady: T | undefined
  let hasPendingRemote = false
  let pendingRemoteRaw: string | null = null

  /**
   * On-disk envelope when `version` is set: `{"v": N, "d": "<serializedT>"}`.
   * Without `version`, we read/write raw (legacy shape). Migration takes the
   * raw inner string + the parsed `v` (or `undefined` for legacy) so the
   * consumer's migrator can replay arbitrary historical formats.
   */
  type Envelope = { v: number; d: string }
  const isEnvelope = (raw: unknown): raw is Envelope =>
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { v?: unknown }).v === 'number' &&
    typeof (raw as { d?: unknown }).d === 'string'

  const encodeForStorage = (value: T): string => {
    const inner = serialize(value)
    if (version === undefined) return inner
    return JSON.stringify({ v: version, d: inner })
  }

  // Apply a cross-tab raw value to the source (a null → `undefined` delete;
  // otherwise parse/deserialize, honoring the version envelope). Shared by the
  // live `onChange` path and the buffered-until-ready replay (T6.1).
  const applyRemote = (rawValue: string | null): void => {
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
      let parsed: unknown
      try {
        parsed = JSON.parse(rawValue)
      } catch {
        parsed = undefined
      }
      let value: T
      if (version !== undefined && isEnvelope(parsed)) {
        if (parsed.v !== version) return // peer on a different schema; ignore.
        value = deserialize(parsed.d) as T
      } else {
        value = deserialize(rawValue) as T
      }
      writingFromLoad = true
      try {
        source.set(value)
      } finally {
        writingFromLoad = false
      }
    } catch (err) {
      reportError(err, 'remoteChange')
    }
  }

  // Flip `ready` and reconcile anything that raced the initial load: a local
  // user write wins outright (and is flushed to storage); otherwise a buffered
  // cross-tab change (the freshest one) is applied. `scheduleWrite` is only
  // reached in the async-load path, where it is already defined below.
  const settleReady = (): void => {
    ready$.set(true)
    if (userWroteBeforeReady) {
      userWroteBeforeReady = false
      hasPendingRemote = false
      scheduleWrite(pendingUserValueBeforeReady as T)
      return
    }
    if (hasPendingRemote) {
      hasPendingRemote = false
      applyRemote(pendingRemoteRaw)
    }
  }

  // Load initial value.
  const loaded = storage.get(key)
  const applyLoaded = async (raw: string | null): Promise<void> => {
    // A local write already raced the load — it wins; don't apply storage.
    // `settleReady` flushes the user's value.
    if (userWroteBeforeReady) {
      settleReady()
      return
    }
    if (raw == null) {
      settleReady()
      return
    }
    let value: T | undefined
    let needsRewrite = false
    try {
      // Try the envelope shape first (for version-aware reads). If it isn't
      // an envelope, treat the raw string as a legacy v=undefined payload.
      let parsedEnvelope: unknown
      try {
        parsedEnvelope = JSON.parse(raw)
      } catch {
        parsedEnvelope = undefined
      }
      if (version !== undefined && isEnvelope(parsedEnvelope)) {
        if (parsedEnvelope.v === version) {
          value = deserialize(parsedEnvelope.d) as T
        } else if (migrate !== undefined) {
          try {
            const migrated = await migrate(parsedEnvelope.d, parsedEnvelope.v)
            if (migrated === undefined) {
              settleReady()
              return
            }
            value = migrated
            needsRewrite = true
          } catch (err) {
            reportError(err, 'migrate')
            settleReady()
            return
          }
        } else {
          // Version mismatch with no migrator — discard.
          settleReady()
          return
        }
      } else if (version !== undefined && migrate !== undefined) {
        // Legacy raw payload but we now require versioning — invoke migrator
        // with `fromVersion: undefined`.
        try {
          const migrated = await migrate(raw, undefined)
          if (migrated === undefined) {
            settleReady()
            return
          }
          value = migrated
          needsRewrite = true
        } catch (err) {
          reportError(err, 'migrate')
          settleReady()
          return
        }
      } else {
        value = deserialize(raw) as T
      }
    } catch (err) {
      reportError(err, 'deserialize')
      settleReady()
      return
    }
    // A write may have landed while we awaited an async migrate — it wins.
    if (userWroteBeforeReady) {
      settleReady()
      return
    }
    writingFromLoad = true
    try {
      source.set(value as T)
    } finally {
      writingFromLoad = false
    }
    settleReady()
    if (needsRewrite) {
      // Persist the migrated value so the next load doesn't re-migrate. Split
      // serialize vs write so a storage-quota throw isn't mislabeled (T6.1).
      let encoded: string
      try {
        encoded = encodeForStorage(value as T)
      } catch (err) {
        reportError(err, 'serialize')
        return
      }
      try {
        const writeResult = storage.set(key, encoded)
        if (writeResult instanceof Promise) writeResult.catch((e) => reportError(e, 'write'))
      } catch (err) {
        reportError(err, 'write')
      }
    }
  }

  if (loaded instanceof Promise) {
    loaded.then(
      (raw) => applyLoaded(raw),
      (err) => {
        reportError(err, 'load')
        settleReady()
      },
    )
  } else {
    applyLoaded(loaded)
  }

  // Optional throttled writer. State is captured per-`usePersisted` call so
  // multiple persisted signals in the same controller don't interfere.
  let pendingWriteValue: T | undefined
  let hasPendingWrite = false
  let writeTimer: ReturnType<typeof setTimeout> | null = null

  const flushWrite = (): void => {
    if (!hasPendingWrite) return
    const value = pendingWriteValue as T
    hasPendingWrite = false
    pendingWriteValue = undefined
    writeTimer = null
    // Encode and write are separate failure domains: encoding is a 'serialize'
    // error; `storage.set` (sync for localStorage — quota throws here) is a
    // 'write' error. The old single try mislabeled every write throw as
    // 'serialize' (T6.1).
    let raw: string
    try {
      raw = encodeForStorage(value)
    } catch (err) {
      reportError(err, 'serialize')
      return
    }
    try {
      const writeResult = storage.set(key, raw)
      if (writeResult instanceof Promise) writeResult.catch((e) => reportError(e, 'write'))
    } catch (err) {
      reportError(err, 'write')
    }
  }

  const scheduleWrite = (value: T): void => {
    if (throttleMs <= 0) {
      pendingWriteValue = value
      hasPendingWrite = true
      flushWrite()
      return
    }
    pendingWriteValue = value
    hasPendingWrite = true
    if (writeTimer === null) {
      writeTimer = setTimeout(flushWrite, throttleMs)
    }
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
    if (!ready$.peek()) {
      // A real user write before the initial load settled — remember it so
      // `settleReady` flushes it and `applyLoaded` doesn't clobber the source.
      // The old code dropped it, then the load overwrote what the user typed
      // (T6.1).
      userWroteBeforeReady = true
      pendingUserValueBeforeReady = value
      return
    }
    scheduleWrite(value)
  })

  // Cross-tab sync.
  let unsubChange: (() => void) | null = null
  if (crossTab && storage.onChange) {
    unsubChange = storage.onChange((changedKey, rawValue) => {
      if (changedKey !== key) return
      if (!ready$.peek()) {
        // Buffer the freshest cross-tab change until the initial load settles;
        // applying it now would race the load and get clobbered by
        // `applyLoaded` (T6.1). A local user write still takes precedence in
        // `settleReady`.
        hasPendingRemote = true
        pendingRemoteRaw = rawValue
        return
      }
      // A null value is a cross-tab delete (`localStorage.removeItem`) — mirror
      // it locally as `undefined`; see `applyRemote`.
      applyRemote(rawValue)
    })
  }

  ctx.onDispose(() => {
    // Flush any pending throttled write before tearing down so we never lose
    // the last value the user produced. Synchronous in localStorage; the
    // Promise return from IDB resolves shortly after dispose returns.
    if (hasPendingWrite) {
      if (writeTimer !== null) clearTimeout(writeTimer)
      flushWrite()
    }
    unsub()
    unsubChange?.()
  })

  return { ready: ready$ }
}

/**
 * Clear every key under a `prefix` (default: clear all). Useful for "log out"
 * flows that want to drop persisted state without enumerating consumers.
 * Errors are routed through the optional `onError` (e.g. quota or security
 * exceptions on `delete`).
 */
export async function clearPersisted(
  storage: StorageAdapter = localStorageAdapter,
  prefix?: string,
  onError?: (err: unknown, key: string) => void,
): Promise<void> {
  if (storage.keys === undefined) return
  let keys: Iterable<string>
  try {
    const result = storage.keys()
    keys = result instanceof Promise ? await result : result
  } catch (err) {
    onError?.(err, '<keys>')
    return
  }
  for (const key of keys) {
    if (prefix !== undefined && !key.startsWith(prefix)) continue
    try {
      const r = storage.delete(key)
      if (r instanceof Promise) await r
    } catch (err) {
      onError?.(err, key)
    }
  }
}
