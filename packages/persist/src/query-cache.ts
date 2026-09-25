import type { DehydratedEntry, DehydratedState, OlasPlugin, QueryRef } from '@kontsedal/olas-core'
import { LOCAL_STORAGE, type StorageAdapter } from './storage'

declare module '@kontsedal/olas-core' {
  interface QueryMeta {
    /**
     * Keep this query's entries in `persistQueryCachePlugin`'s storage, so a reload
     * starts from them. Opt-in, because a cache can hold data that must not
     * outlive the session.
     */
    persist?: boolean
  }
}

/** The plugin's name. */
export const PERSIST_QUERY_CACHE_PLUGIN_NAME = 'olas-persist-query-cache'

const FORMAT = 1

/** Where a `persistQueryCachePlugin` error came from. */
export type QueryCacheErrorOp = 'restore' | 'write'

/** Options for `persistQueryCachePlugin` and `restoreQueryCache`. */
export type PersistQueryCacheOptions = {
  /**
   * Where the cache is kept. Default `localStorageAdapter()`.
   */
  storage?: StorageAdapter
  /**
   * The storage key the whole cache is written under. Default `'olas/query-cache'`.
   */
  key?: string
  /**
   * A version for the stored shape. A cache written under a different buster
   * is discarded at restore; change it when a persisted query's data changes
   * shape. Default `''`.
   */
  buster?: string
  /**
   * Entries whose data is older than this are not restored. Default 24 hours.
   */
  maxAgeMs?: number
  /**
   * At most one storage write per window, carrying the latest cache. Default 1000.
   */
  throttleMs?: number
  /**
   * Which queries persist. Default: those with `meta: { persist: true }`. A
   * stored entry of a query the root has used and `include` rejects is
   * dropped from storage.
   */
  include?: (query: QueryRef) => boolean
  /**
   * Restore the stored cache when the root starts. Default `true`. Pass
   * `false` when the app restored it already with `restoreQueryCache` and
   * handed the result to `createRoot({ hydrate })`. The plugin still reads
   * storage at startup then, without hydrating it, so its writes keep the
   * stored entries this session never binds.
   */
  restore?: boolean
  /**
   * A failed read, parse or write. A failed read reports `'restore'`, with or
   * without `restore`. Default: a warning in development.
   */
  onError?: (error: unknown, op: QueryCacheErrorOp) => void
}

type Stored = { v: typeof FORMAT; buster: string; entries: DehydratedEntry[] }

const DEFAULT_KEY = 'olas/query-cache'
const DAY_MS = 24 * 60 * 60 * 1000
/** How far in the future a stored timestamp may sit, for clock drift between loads. */
const CLOCK_SKEW_MS = 5 * 60_000

const defaultOnError = (error: unknown, op: QueryCacheErrorOp): void => {
  if (__DEV__) console.warn(`[olas/persist] persistQueryCachePlugin ${op} failed:`, error)
}

const isEntry = (e: unknown): e is DehydratedEntry => {
  if (typeof e !== 'object' || e === null) return false
  const x = e as Record<string, unknown>
  return (
    typeof x.id === 'string' &&
    Array.isArray(x.key) &&
    typeof x.lastUpdatedAt === 'number' &&
    Number.isFinite(x.lastUpdatedAt) &&
    (x.pageParams === undefined || Array.isArray(x.pageParams))
  )
}

/**
 * Parse a stored cache, keeping only well-formed entries under the right
 * buster and within `maxAgeMs`. `undefined` for a missing, foreign or corrupt
 * payload.
 */
function parse(
  raw: string | null,
  buster: string,
  maxAgeMs: number,
): DehydratedEntry[] | undefined {
  if (raw === null) return undefined
  const stored = JSON.parse(raw) as Partial<Stored> | null
  if (stored === null || typeof stored !== 'object') return undefined
  if (stored.v !== FORMAT || stored.buster !== buster || !Array.isArray(stored.entries)) {
    return undefined
  }
  const now = Date.now()
  // A timestamp in the future is corrupt, or planted: it would pass `maxAgeMs`
  // and keep the entry fresh for any `staleTime`, so its data never refetches.
  return stored.entries.filter(
    (e) => isEntry(e) && e.lastUpdatedAt <= now + CLOCK_SKEW_MS && now - e.lastUpdatedAt < maxAgeMs,
  )
}

/**
 * Read the stored cache ahead of `createRoot`, for storage that reads
 * asynchronously (IndexedDB). Resolves with a `DehydratedState` for
 * `createRoot({ hydrate })`, or `undefined` when there is nothing to restore.
 *
 * ```ts
 * const storage = indexedDbAdapter()
 * const hydrate = await restoreQueryCache({ storage })
 * const root = createRoot(app, {
 *   deps,
 *   queries: queryEngine(),
 *   hydrate,
 *   plugins: [persistQueryCachePlugin({ storage, restore: false })],
 * })
 * ```
 */
export async function restoreQueryCache(
  options: PersistQueryCacheOptions = {},
): Promise<DehydratedState | undefined> {
  const storage = options.storage ?? LOCAL_STORAGE
  const onError = options.onError ?? defaultOnError
  try {
    const entries = parse(
      await storage.get(options.key ?? DEFAULT_KEY),
      options.buster ?? '',
      options.maxAgeMs ?? DAY_MS,
    )
    return entries === undefined || entries.length === 0 ? undefined : { version: 1, entries }
  } catch (error) {
    onError(error, 'restore')
    return undefined
  }
}

/**
 * Persist the query cache across reloads. The plugin writes every canonical
 * write of an opted-in query (a fetch, `write`, `replace` or hydration) to
 * storage, throttled, and restores the stored cache when the root starts.
 * Optimistic writes and rollbacks are guesses the server has not confirmed,
 * so they are not persisted. An entry the cache garbage-collects is dropped
 * from storage too.
 *
 * ```ts
 * const user = defineQuery({ id: 'user', key: () => [], fetcher, meta: { persist: true } })
 *
 * createRoot(app, { deps, queries: queryEngine(), plugins: [persistQueryCachePlugin()] })
 * ```
 *
 * With synchronous storage (the default, localStorage) the restore happens
 * during setup, before any controller subscribes, so a restored entry is
 * there on the first read. With asynchronous storage the restore lands later.
 * It fills only entries nothing has subscribed to yet, and never overwrites
 * one a fetch is already filling. `root.waitForIdle()` waits for it. Await
 * `restoreQueryCache` before `createRoot` instead when the first render must
 * see the restored data.
 *
 * Every storage write carries the whole cache, so the plugin reads what
 * storage holds at startup even with `restore: false`, and holds its first
 * write until an asynchronous read lands. An entry this session never binds
 * therefore stays in storage until it passes `maxAgeMs`. A read that fails
 * holds the writes: the next flush reads storage again, and writes once a
 * read lands. A session whose reads all fail writes nothing, because its
 * write would delete the entries it could not read.
 */
export function persistQueryCachePlugin(options: PersistQueryCacheOptions = {}): OlasPlugin {
  const storage = options.storage ?? LOCAL_STORAGE
  const storageKey = options.key ?? DEFAULT_KEY
  const buster = options.buster ?? ''
  const maxAgeMs = options.maxAgeMs ?? DAY_MS
  const throttleMs = options.throttleMs ?? 1000
  const include = options.include ?? ((query: QueryRef) => query.meta.persist === true)
  const onError = options.onError ?? defaultOnError

  return {
    name: PERSIST_QUERY_CACHE_PLUGIN_NAME,
    setup(host) {
      const queries = host.queries
      if (queries === null) {
        if (__DEV__) {
          console.warn(
            '[olas/persist] persistQueryCachePlugin needs a query engine: ' +
              'createRoot(app, { queries: queryEngine(), plugins: [persistQueryCachePlugin()] })',
          )
        }
        return
      }

      /**
       * What storage holds, by `${id}\u0000${hash}`. What storage held at
       * startup seeds it, with or without `restore`: a flush writes the whole
       * map, so an entry left out of it is deleted from storage.
       */
      const cache = new Map<string, DehydratedEntry>()
      const slot = (id: string, key: readonly unknown[]): string =>
        `${id}\u0000${queries.hashKey(key)}`
      const restoring = options.restore !== false
      // A stored entry of a query this root has used and `include` now
      // rejects: the query opted out after the entry was written. An entry of
      // a query the root has not used is kept, since nothing says it opted out.
      const kept = (e: DehydratedEntry): boolean => {
        const query = queries.get(e.id)
        return query === undefined || include(query)
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      let disposed = false
      // Until a read of storage lands, `cache` lacks what storage holds, and a
      // flush would delete the entries it could not read. So a flush reads
      // first, and waits while a read is in flight. A read that fails holds
      // the write until the next flush, which reads again: one read per flush.
      let seeded = false
      let reading = false
      let held = false

      const flush = (): void => {
        timer = null
        if (!seeded && !reading) read()
        held = !seeded
        if (held) return
        const payload: Stored = { v: FORMAT, buster, entries: [...cache.values()].filter(kept) }
        let json: string
        try {
          json = JSON.stringify(payload)
        } catch (error) {
          onError(error, 'write')
          return
        }
        try {
          const written = storage.set(storageKey, json)
          if (written instanceof Promise) {
            host.track(written.catch((error: unknown) => onError(error, 'write')))
          }
        } catch (error) {
          onError(error, 'write')
        }
      }
      const schedule = (): void => {
        if (disposed || timer !== null) return
        if (throttleMs <= 0) {
          flush()
          return
        }
        timer = setTimeout(flush, throttleMs)
      }

      /**
       * Seed `cache` with what storage holds and, with `restore`, hydrate the
       * root with it. An entry a subscriber bound already is not hydrated.
       */
      const load = (entries: DehydratedEntry[] | undefined): void => {
        if (entries === undefined) return
        const fresh: DehydratedEntry[] = []
        for (const e of entries) {
          if (!kept(e)) continue
          const k = slot(e.id, e.key)
          // A write that landed before the read is newer than storage.
          if (!cache.has(k)) cache.set(k, e)
          if (!restoring) continue
          // Never fill an entry that exists already: a subscriber bound it, and
          // its fetch is newer than anything storage holds.
          if (queries.keys(e.id).some((key) => slot(e.id, key) === k)) continue
          fresh.push(e)
        }
        // A root disposed while the read was in flight takes no hydration.
        if (fresh.length > 0 && !disposed) queries.hydrate({ version: 1, entries: fresh })
      }
      // A payload that fails to parse counts as read: writing over it loses
      // nothing. A parse or restore that throws is reported on both paths.
      const seed = (raw: string | null): void => {
        seeded = true
        try {
          load(parse(raw, buster, maxAgeMs))
        } catch (error) {
          onError(error, 'restore')
        }
      }
      const read = (): void => {
        try {
          const raw = storage.get(storageKey)
          if (raw instanceof Promise) {
            reading = true
            host.track(
              raw
                .then(seed, (error: unknown) => onError(error, 'restore'))
                .finally(() => {
                  reading = false
                  if (seeded && held) flush()
                }),
            )
          } else {
            seed(raw)
          }
        } catch (error) {
          onError(error, 'restore')
        }
      }
      read()

      host.onDispose(() => {
        disposed = true
        if (timer !== null) clearTimeout(timer)
        // A pending or held write. During a read it waits for the read, and a
        // held write reads storage once more first.
        if (timer !== null || held) flush()
      })

      return {
        onWrite(event) {
          if (!include(event.query)) return
          if (event.source === 'optimistic' || event.source === 'rollback') return
          if (event.data === undefined) return
          cache.set(slot(event.query.id, event.key), {
            id: event.query.id,
            key: event.key,
            data: event.data,
            lastUpdatedAt: event.updatedAt,
            ...(event.pageParams !== undefined ? { pageParams: event.pageParams } : {}),
          })
          schedule()
        },
        onRemove(event) {
          if (cache.delete(slot(event.query.id, event.key))) schedule()
        },
      }
    },
  }
}
