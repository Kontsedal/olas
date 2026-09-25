import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
import { signal, untracked } from '@kontsedal/olas-core'
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
   * `onChange`. Default `false`. Another tab's value is read as a load is: a
   * payload of an older version goes through `migrate`, and is dropped without
   * one. A payload of a newer version is dropped. A migrated value is not
   * written back, because the tab that wrote it still reads that key. A throttled write still waiting here is dropped,
   * since the other tab's value is newer.
   */
  crossTab?: boolean
  /**
   * Schema version. When the value loaded from storage carries an older
   * `version`, `migrate(raw, fromVersion)` is invoked to bring it forward;
   * the migrated value is written back, unless another tab's change arrived
   * during the load. A newer `version`, which a later build wrote, is
   * ignored and left in storage. When omitted, no version gate runs:
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
   * keeps its current value). A cross-tab change of an older version goes
   * through it too, and an async result applies only if no newer change or
   * local write came first. A payload of a newer version never reaches it.
   */
  migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<T | undefined>
  /**
   * Throttle writes: at most one per `throttleMs` milliseconds, carrying the
   * latest value (a trailing write — the first change opens the window, and
   * the value current when it closes is what lands). Useful for
   * high-frequency sources (cursor position, scroll, every-keystroke field)
   * where "write on every change" is too chatty. Defaults to `0`, a write per
   * change. A pending write is flushed when the controller disposes, and
   * dropped when a cross-tab change arrives first.
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
   * Override the `BroadcastChannel` constructor. Defaults to the global one
   * in a browser tab or web worker, and to none on a server (Node, Bun,
   * Deno), where a channel reaches every adapter in the process. Pass one to
   * opt in anywhere. Without a channel, `onChange` subscriptions still
   * register but never fire.
   */
  broadcastChannel?: typeof BroadcastChannel
}

/**
 * IndexedDB-backed `StorageAdapter`. Async on every operation; cross-tab
 * change notifications layered via `BroadcastChannel` in a browser (IDB has
 * no native change event, so external IDB writes by code that doesn't go
 * through this adapter are *not* observed). When no `IDBFactory` is available
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

  // Forget a connection, so the next call opens a new one. Only the promise
  // it came from is dropped: a newer connection stays.
  const forget = (pending: Promise<IDBDatabase>): void => {
    if (dbPromise === pending) dbPromise = null
  }

  const openDb = (): Promise<IDBDatabase> | null => {
    if (idbFactory === undefined) return null
    if (dbPromise !== null) return dbPromise
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
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
          forget(pending)
        }
        // The browser closed the connection abnormally: WebKit's "connection
        // lost", or the user clearing site data. Every `transaction()` on it
        // throws from then on, so the next call opens a new one.
        db.onclose = () => forget(pending)
        resolve(db)
      }
      req.onerror = () => reject(req.error ?? new Error('[olas-persist] IDB open failed'))
    })
    dbPromise = pending
    // Lazy connection — if the open fails, future calls retry rather than
    // staying stuck on a poisoned promise.
    pending.catch(() => forget(pending))
    return pending
  }

  /**
   * Start a transaction on the cached connection. A connection the browser
   * closed throws InvalidStateError before its `close` event arrives, so on
   * that error the connection is dropped and the call tries once more, on a
   * new one.
   */
  const transaction = async (mode: IDBTransactionMode): Promise<IDBTransaction | null> => {
    for (let attempt = 0; ; attempt++) {
      const pending = openDb()
      if (pending === null) return null
      const db = await pending
      try {
        return db.transaction(storeName, mode)
      } catch (err) {
        if (attempt > 0 || (err as { name?: unknown } | null)?.name !== 'InvalidStateError') {
          throw err
        }
        forget(pending)
      }
    }
  }

  const runRequest = async <T>(
    mode: IDBTransactionMode,
    build: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | undefined> => {
    const tx = await transaction(mode)
    if (tx === null) return undefined
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false
      const fail = (err: unknown): void => {
        if (settled) return
        settled = true
        reject(err ?? new Error('[olas-persist] IDB request failed'))
      }
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

/**
 * The platform `BroadcastChannel`, in a browser scope only: a document (a tab
 * or an iframe), or a web worker. Node, Bun and Deno define one too, but there
 * it reaches every adapter in the process, so per-request server roots would
 * read each other's writes. The same rule as `@kontsedal/olas-cross-tab`'s
 * default factory. The document check comes first, since in a tab HTML named
 * access makes an element with the id `Bun` the global `Bun`.
 */
function getGlobalBroadcastChannel(): typeof BroadcastChannel | undefined {
  const g = globalThis as { Deno?: unknown; Bun?: unknown; WorkerGlobalScope?: unknown }
  const browser =
    (typeof document === 'object' && document !== null) ||
    (g.Deno === undefined &&
      g.Bun === undefined &&
      typeof g.WorkerGlobalScope === 'function' &&
      globalThis instanceof g.WorkerGlobalScope)
  return typeof BroadcastChannel === 'undefined' || !browser ? undefined : BroadcastChannel
}

/**
 * The envelope a stored string holds, as `[payload, version, marked]`, or
 * `undefined` for a raw payload. `marked` is true for the
 * `{"$olas":1, v?, d}` shape 1.0 writes: the `$olas` key is the marker. An
 * unmarked `{v, d}` is the shape earlier versions wrote, and a user value can
 * have it too. A marked envelope with no `d`, and no key but `$olas` and
 * `v`, is the envelope of `undefined`, which has no serialized form: its
 * payload is `undefined`. The reader and the writer both ask this function,
 * so they agree on what an envelope is. A string that does not start with
 * `{`, or names neither a `"d"` nor a `"$olas"` key, is not one, which spares
 * most writes a parse.
 */
function envelopeOf(raw: string): [string | undefined, number | undefined, boolean] | undefined {
  if (raw[0] === '{' && (raw.includes('"d"') || raw.includes('"$olas"'))) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const { d, v, $olas: mark } = parsed
      const marked = mark === 1
      if (typeof d === 'string' && (typeof v === 'number' || (marked && v === undefined))) {
        return [d, v as number | undefined, marked]
      }
      if (
        marked &&
        (v === undefined || typeof v === 'number') &&
        Object.keys(parsed).every((k) => k === '$olas' || k === 'v')
      ) {
        return [undefined, v as number | undefined, true]
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
  // The source's value before the load: what a reload finds when storage has
  // no value, and what a peer's delete puts back.
  const unloaded = untracked(() => source.value)
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
   *
   * `undefined` is the marked envelope with no `d`: `{"$olas":1}`, or
   * `{"$olas":1,"v":N}` with `version`. `serialize` is not called for it,
   * because `JSON.stringify(undefined)` returns no string at all.
   */
  const encodeForStorage = (value: T): string => {
    // `JSON.stringify` drops `v` when `version` is undefined.
    if (value === undefined) return JSON.stringify({ $olas: 1, v: version })
    const inner = serialize(value)
    if (typeof inner !== 'string') {
      throw new TypeError(`[olas/persist] serialize returned ${typeof inner}, not a string`)
    }
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
   * stays whole. The payload is `undefined` for the envelope of `undefined`.
   */
  const decode = (raw: string): [payload: string | undefined, from: number | undefined] => {
    const env = envelopeOf(raw)
    return env !== undefined && (env[2] || version !== undefined)
      ? [env[0], env[1]]
      : [raw, undefined]
  }

  // A payload a newer build wrote. `migrate` brings values forward only, and a
  // step migrator would pass the newer shape through unchanged, so both the
  // load and the cross-tab path drop it.
  const isNewer = (from: number | undefined): boolean =>
    from !== undefined && version !== undefined && from > version

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

  // A peer's change supersedes a throttled write still waiting here: that
  // write holds an older value, and flushing it would put it back in storage
  // while this tab shows the peer's.
  const dropPendingWrite = (): void => {
    if (writeTimer !== null) clearTimeout(writeTimer)
    writeTimer = null
    hasPendingWrite = false
    pendingWriteValue = undefined
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

  // Bumped by every cross-tab change and every local write after ready. A
  // peer's payload that is still migrating applies only if nothing came since.
  let lastChange = 0

  // Put a peer's value in the source, and drop the throttled write it
  // supersedes. `writingFromLoad` keeps the write from echoing to storage.
  const setFromRemote = (value: T): void => {
    writingFromLoad = true
    try {
      source.set(value)
    } catch (err) {
      reportError(err, 'remoteChange')
      return
    } finally {
      writingFromLoad = false
    }
    dropPendingWrite()
  }

  // Apply a cross-tab raw value to the source, so the source holds what a
  // reload would load. A null is a delete, and a reload of a missing key
  // keeps the source's value from before the load, so a delete puts that
  // value back. Anything else is read as the load path reads it, so a
  // payload of another version, or a raw one from a build before versioning,
  // goes through `migrate`, and without a migrator it is dropped. A migrated
  // peer value is not written back: the build that wrote it still reads that
  // key. Shared by the live `onChange` path and the buffered-until-ready
  // replay (T6.1).
  const applyRemote = (rawValue: string | null): void => {
    const change = ++lastChange
    if (rawValue == null) {
      setFromRemote(unloaded)
      return
    }
    const [payload, from] = decode(rawValue)
    if (payload === undefined) {
      // The envelope of `undefined`, which has no shape to migrate.
      if (!isNewer(from)) setFromRemote(undefined as T)
      return
    }
    if (
      version === undefined ||
      from === version ||
      (from === undefined && migrate === undefined)
    ) {
      let value: T
      try {
        value = deserialize(payload) as T
      } catch (err) {
        reportError(err, 'remoteChange')
        return
      }
      setFromRemote(value)
      return
    }
    if (migrate === undefined || isNewer(from)) return
    const settle = (migrated: T | undefined): void => {
      if (migrated === undefined || change !== lastChange) return
      setFromRemote(migrated)
    }
    let migrated: T | undefined | Promise<T | undefined>
    try {
      migrated = migrate(payload, from)
    } catch (err) {
      reportError(err, 'migrate')
      return
    }
    if (migrated instanceof Promise) {
      migrated.then(settle, (err: unknown) => reportError(err, 'migrate'))
    } else {
      settle(migrated)
    }
  }

  // Flip `ready` and reconcile anything that raced the initial load: a local
  // user write wins outright (and is flushed to storage); otherwise a buffered
  // cross-tab change (the freshest one) is applied.
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
      if (payload === undefined) {
        // The envelope of `undefined`, which has no shape to migrate. A newer
        // build's is dropped like any newer payload.
        if (isNewer(from)) {
          settleReady()
          return
        }
        value = undefined
      } else if (
        version === undefined ||
        from === version ||
        (from === undefined && migrate === undefined)
      ) {
        value = deserialize(payload) as T
      } else if (migrate !== undefined && !isNewer(from)) {
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
        // No migrator, or a newer build's payload: discard, and leave storage
        // to the build that wrote it.
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
    const change = lastChange
    settleReady()
    // A peer's change that raced the load was just applied. Storage holds it,
    // and it is newer than the migrated value, so the rewrite is skipped.
    if (needsRewrite && change === lastChange) {
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

  // Load the initial value. A read that fails, by throwing or by rejecting,
  // is reported, and the source keeps its value. `ready` still settles, so
  // later writes persist.
  const loadFailed = (err: unknown): void => {
    reportError(err, 'load')
    settleReady()
  }
  let loaded: string | null | Promise<string | null> = null
  let readThrew = false
  try {
    loaded = storage.get(key)
  } catch (err) {
    readThrew = true
    loadFailed(err)
  }
  if (loaded instanceof Promise) {
    loaded.then((raw) => applyLoaded(raw), loadFailed)
  } else if (!readThrew) {
    applyLoaded(loaded)
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
    lastChange += 1
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
