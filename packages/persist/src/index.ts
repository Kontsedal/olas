import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
import { signal } from '@kontsedal/olas-core'
import { LOCAL_STORAGE, type StorageAdapter } from './storage'

export {
  PERSIST_QUERY_CACHE_PLUGIN_NAME,
  type PersistQueryCacheOptions,
  persistQueryCachePlugin,
  type QueryCacheErrorOp,
  restoreQueryCache,
} from './query-cache'
export { localStorageAdapter, type StorageAdapter } from './storage'

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

/** Options for `createPersisted(ctx, key, source, options?)`. */
export type PersistOptions<T> = {
  /**
   * Storage backend. When omitted *or explicitly `undefined`* (handy for app
   * code that forwards a deps slot like `ctx.deps.storage`), the browser
   * `localStorageAdapter()` is used. SSR-safe — the localStorage adapter no-ops
   * when `localStorage` isn't defined.
   */
  storage?: StorageAdapter | undefined
  /**
   * Turns a value into the stored string. Default `JSON.stringify`.
   */
  serialize?: (value: T) => string
  /**
   * Turns a stored string back into a value. Default `JSON.parse`.
   */
  deserialize?: (raw: string) => T
  /**
   * Apply another tab's write to the same key. Needs a storage adapter with
   * `onChange`. Default `false`.
   */
  crossTab?: boolean
  /**
   * Schema version. When the value loaded from storage carries a different
   * `version`, `migrate(raw, fromVersion)` is invoked to bring it forward;
   * the migrated value is written back. When omitted, no version gate runs:
   * payloads are written raw, and a versioned payload that a newer build
   * wrote is unwrapped and read.
   *
   * With `version` set, every write is the envelope
   * `{"$olas":1,"v":N,"d":<serialized>}`. The `$olas` marker keeps a reader
   * from taking a user value of that shape for an envelope. Reads accept the
   * marked envelope, the unmarked `{"v":N,"d":…}` that earlier versions
   * wrote, and a raw payload.
   */
  version?: number
  /**
   * Migrate a raw payload of a prior version. Receives the pre-deserialize
   * string and the version number it was written with (or `undefined` if no
   * version stamp existed, i.e. the legacy raw shape). Return the migrated
   * payload AS A `T` value (post-deserialize); `createPersisted` re-serializes
   * it before writing. Return `undefined` to drop the entry (the source
   * keeps its current value).
   */
  migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<T | undefined>
  /**
   * Throttle writes: at most one per `throttleMs` milliseconds, carrying the
   * latest value (a trailing write — the first change opens the window, and
   * the value current when it closes is what lands). Useful for
   * high-frequency sources (cursor position, scroll, every-keystroke field)
   * where "write on every change" is too chatty. Defaults to `0`, a write per
   * change. A pending write is flushed when the controller disposes.
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

/** What `createPersisted` returns. */
export type Persisted = {
  /**
   * `true` once the stored value has loaded: at once for `localStorage`, and
   * after the read resolves for an async adapter.
   */
  ready: ReadSignal<boolean>
}

/**
 * What `createPersisted` can persist: anything with `value`, `set` and
 * `subscribe`, such as a `Signal<T>` or a `Field<T>`. `subscribe` may call the
 * handler at once with the current value, or only on a change.
 */
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
  /**
   * Database name. Defaults to `'olas-persist'`.
   */
  databaseName?: string
  /**
   * Object store inside the database. Defaults to `'kv'`.
   */
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
 * fine for the persisted-signal use case `createPersisted` is built around.
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
      // error routing runs (`createPersisted` → `onError('load')`). A missing key
      // is not an error — `req.result` is `undefined`, so we return null.
      const result = await runRequest<unknown>('readonly', (s) => s.get(key))
      return typeof result === 'string' ? result : null
    },
    async set(key: string, value: string): Promise<void> {
      if (idbFactory === undefined) return
      // Do NOT swallow — a rejected write (quota, closed db, aborted commit)
      // propagates so `createPersisted`'s `onError('write')` fires (T6.1). The
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

/**
 * The envelope a stored string holds, as `[payload, version, marked]`, or
 * `undefined` for a raw payload. `marked` is true for the
 * `{"$olas":1, v?, d}` shape 1.0 writes: the `$olas` key is the marker. An
 * unmarked `{v, d}` is the shape earlier versions wrote, and a user value can
 * have it too. The reader and the writer both ask this function, so they
 * agree on what an envelope is. A string that does not start with `{` or
 * never names a `"d"` key is not one, which spares most writes a parse.
 */
function envelopeOf(raw: string): [string, number | undefined, boolean] | undefined {
  if (raw[0] === '{' && raw.includes('"d"')) {
    try {
      const { d, v, $olas: mark } = JSON.parse(raw)
      const marked = mark === 1
      if (typeof d === 'string' && (typeof v === 'number' || (marked && v === undefined))) {
        return [d, v, marked]
      }
    } catch {
      /* not JSON, so a raw payload */
    }
  }
  return undefined
}

/**
 * Persist a signal-like source under `key`. Loads the stored value on
 * construction (sync for localStorage, async for any storage that returns a
 * promise). Subsequent writes to the source are mirrored to storage.
 *
 * Cleanup (unsubscribe + cross-tab listener removal) is bound to `ctx`.
 */
export function createPersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,
  options?: PersistOptions<T>,
): Persisted {
  const storage = options?.storage ?? LOCAL_STORAGE
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
   * With `version` set, every write is the marked envelope
   * `{"$olas":1,"v":N,"d":"<serialized>"}`. Without it, a write is the raw
   * serialized string, unless a reader could take that string for an
   * envelope: then it is wrapped as `{"$olas":1,"d":"<serialized>"}`, so it
   * reads back as itself. Migration takes the inner string and the version it
   * was written under (`undefined` for a raw payload), so the consumer's
   * migrator can replay arbitrary historical formats.
   */
  const encodeForStorage = (value: T): string => {
    const inner = serialize(value)
    // `JSON.stringify` drops `v` when `version` is undefined.
    return version === undefined && envelopeOf(inner) === undefined
      ? inner
      : JSON.stringify({ $olas: 1, v: version, d: inner })
  }

  /**
   * The serialized payload in a stored string, and the version it was
   * written under. A marked envelope is unwrapped for every reader, so a tab
   * without `version` reads a value a newer build wrote with one. An unmarked
   * `{v, d}` is an envelope only to a reader with `version`: to one without,
   * it is a value stored before 1.0 that happens to have that shape, and it
   * stays whole.
   */
  const decode = (raw: string): [payload: string, from: number | undefined] => {
    const env = envelopeOf(raw)
    return env !== undefined && (env[2] || version !== undefined)
      ? [env[0], env[1]]
      : [raw, undefined]
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
      const [payload, from] = decode(rawValue)
      // A peer on a different schema; ignore. Without `version`, every
      // payload is read.
      if (version !== undefined && from !== undefined && from !== version) return
      const value = deserialize(payload) as T
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
      const [payload, from] = decode(raw)
      if (
        version === undefined ||
        from === version ||
        (from === undefined && migrate === undefined)
      ) {
        value = deserialize(payload) as T
      } else if (migrate !== undefined) {
        // An older envelope, or a raw payload now that we require versioning
        // (`fromVersion: undefined`).
        try {
          const migrated = await migrate(payload, from)
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
    } catch (err) {
      // The stored value parsed but the source refused it, a shape it does not
      // accept. Report it, and settle `ready` so later writes still persist.
      reportError(err, 'deserialize')
      settleReady()
      return
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

  // Optional throttled writer. State is captured per-`createPersisted` call so
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

  // Persist on every CHANGE. A signal's `subscribe` calls the handler at once,
  // inside `subscribe()`, with the current value. That call is not a change:
  // writing it would store what we just loaded, or the source's default
  // before an async load. Only a call made while `subscribe()` runs is
  // skipped, so a source that does not call back on subscribe keeps its
  // first real change.
  let subscribing = true
  const unsub = source.subscribe((value) => {
    if (subscribing || writingFromLoad) return
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
  subscribing = false

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
 * Options for `clearPersisted(storage?, options)`. Pass a non-empty `prefix`,
 * or `all: true`. With neither, the call throws.
 */
export type ClearPersistedOptions = {
  /**
   * Delete only keys starting with this. Must be non-empty.
   */
  prefix?: string
  /**
   * Delete EVERY key the adapter enumerates. Required when no `prefix` is
   * given, because the default adapter is `localStorage` — which the whole
   * origin shares. Without the opt-in, a "log out" would also take the
   * analytics ids, the consent record, and whatever a third-party script
   * put there.
   */
  all?: boolean
  /**
   * Receives each failed delete with its key, and a failed enumeration under `'<keys>'`.
   */
  onError?: (err: unknown, key: string) => void
}

/**
 * Clear persisted keys. Useful for "log out" flows that want to drop stored
 * state without enumerating consumers. Errors — quota, security exceptions
 * on `delete` — are routed through the optional `onError`; a failed
 * enumeration reports under the key `'<keys>'`.
 *
 * Scope is never implicit: pass a `prefix`, or pass `all: true` to accept
 * that everything the adapter can see goes. With neither, it throws.
 *
 * ```ts
 * await clearPersisted(localStorageAdapter(), { prefix: 'my-app/' })
 * await clearPersisted(sessionAdapter, { all: true })
 * ```
 *
 * An adapter without `keys()` cannot be enumerated, so the call reports
 * `'<keys>'` through `onError` and deletes nothing.
 */
export async function clearPersisted(
  storage: StorageAdapter = LOCAL_STORAGE,
  options: ClearPersistedOptions = {},
): Promise<void> {
  const prefix = options.prefix
  const onError = options.onError
  if (prefix === undefined || prefix === '') {
    if (options.all !== true) {
      throw new Error(
        '[olas/persist] clearPersisted: pass a non-empty `prefix`, or `{ all: true }` to' +
          ' delete every key the adapter enumerates. The default adapter is localStorage,' +
          ' which the whole origin shares, so an unscoped clear takes keys this app never wrote.',
      )
    }
  }
  if (storage.keys === undefined) {
    onError?.(
      new Error(
        '[olas/persist] clearPersisted: the storage adapter has no keys(), so its contents' +
          ' cannot be enumerated. Nothing was deleted.',
      ),
      '<keys>',
    )
    return
  }
  let keys: Iterable<string>
  try {
    const result = storage.keys()
    keys = result instanceof Promise ? await result : result
  } catch (err) {
    onError?.(err, '<keys>')
    return
  }
  // Snapshot before deleting — an adapter whose `keys()` returns a live view
  // (localStorage's does not, but a Map-backed one might) would otherwise be
  // mutated mid-iteration.
  for (const key of [...keys]) {
    if (prefix !== undefined && prefix !== '' && !key.startsWith(prefix)) continue
    try {
      const r = storage.delete(key)
      if (r instanceof Promise) await r
    } catch (err) {
      onError?.(err, key)
    }
  }
}
