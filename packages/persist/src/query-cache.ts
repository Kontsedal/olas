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
   * handed the result to `createRoot({ hydrate })`. Every write reads storage
   * first and merges into it either way, so the stored entries this session
   * never binds are kept.
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
 * Persist the query cache across reloads. The plugin stores each opted-in
 * entry's server truth, throttled, and restores the stored cache when the
 * root starts. Server truth is what `dehydrate()` would ship: while an
 * optimistic write is live, the data beneath it, so a guess is never stored,
 * whichever write carried it, and a committed one is. An entry the cache
 * garbage-collects is dropped from storage too.
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
 * Every storage write carries the whole cache, and every tab of the app
 * writes the same key. So each write reads what storage holds first and
 * merges this session's writes into it. An entry this session never binds
 * stays in storage until it passes `maxAgeMs`, and so does an entry another
 * tab wrote. When both hold a copy of one entry, the one with the newer
 * `lastUpdatedAt` is kept. A read that fails holds the write: the next write
 * reads storage again, and writes once a read lands. A session whose reads
 * all fail writes nothing, because its write would delete the entries it
 * could not read.
 *
 * The read and the write are two steps, not one transaction. Two tabs that
 * write in the same moment can each miss the other's newest entry. The next
 * write of the tab that lost it puts it back, since each write carries every
 * entry its tab wrote.
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

      const slot = (id: string, key: readonly unknown[]): string =>
        `${id}\u0000${queries.hashKey(key)}`
      /**
       * The latest canonical write of each entry this session wrote, by
       * `${id}\u0000${hash}`. Storage is shared: another tab of the app writes
       * the same key, so a flush reads what storage holds and merges this map
       * into it, rather than writing the map over it.
       */
      const written = new Map<string, DehydratedEntry>()
      /**
       * Entries this session garbage-collected, with the `lastUpdatedAt` of
       * the copy it dropped. The merge drops a stored row of that age or
       * older, so it does not bring the entry back. A newer row came from
       * another tab, and stays.
       */
      const removed = new Map<string, number>()
      // A stored entry of a query this root has used and `include` now
      // rejects: the query opted out after the entry was written. An entry of
      // a query the root has not used is kept, since nothing says it opted out.
      const kept = (e: DehydratedEntry): boolean => {
        const query = queries.get(e.id)
        return query === undefined || include(query)
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      let disposed = false
      // A flush reads storage before it writes, because a write carries the
      // whole cache and would delete every row it did not read. `held` is a
      // flush waiting for a read to land. A read that fails leaves it held
      // until the next flush, which reads again: one read per flush. `reading`
      // is a read in flight, which a flush waits for rather than read twice.
      let held = false
      let reading = false

      /**
       * What a flush writes: every stored row the filters keep, with this
       * session's writes merged in. When both have a row for one entry, the
       * newer `lastUpdatedAt` wins, so an older copy this tab restored never
       * lands over the fresher one another tab fetched. A row this session
       * removed stays out, unless another tab wrote it again since.
       */
      const merge = (stored: DehydratedEntry[] | undefined): DehydratedEntry[] => {
        const out = new Map<string, DehydratedEntry>()
        const put = (k: string, e: DehydratedEntry): void => {
          const prev = out.get(k)
          if (prev === undefined || prev.lastUpdatedAt <= e.lastUpdatedAt) out.set(k, e)
        }
        for (const e of stored ?? []) {
          if (!kept(e)) continue
          const k = slot(e.id, e.key)
          const gone = removed.get(k)
          if (gone !== undefined && e.lastUpdatedAt <= gone) continue
          put(k, e)
        }
        for (const [k, e] of written) if (kept(e)) put(k, e)
        return [...out.values()]
      }

      const write = (stored: DehydratedEntry[] | undefined): void => {
        held = false
        const payload: Stored = { v: FORMAT, buster, entries: merge(stored) }
        let json: string
        try {
          json = JSON.stringify(payload)
        } catch (error) {
          onError(error, 'write')
          return
        }
        try {
          const done = storage.set(storageKey, json)
          if (done instanceof Promise) {
            host.track(done.catch((error: unknown) => onError(error, 'write')))
          }
        } catch (error) {
          onError(error, 'write')
        }
      }

      /**
       * Hydrate the root with the stored entries. An entry a subscriber bound
       * already is not filled: its fetch is newer than anything storage holds.
       */
      const hydrate = (entries: DehydratedEntry[] | undefined): void => {
        // A root disposed while the read was in flight takes no hydration.
        if (entries === undefined || disposed) return
        const fresh: DehydratedEntry[] = []
        for (const e of entries) {
          if (!kept(e)) continue
          const k = slot(e.id, e.key)
          if (queries.keys(e.id).some((key) => slot(e.id, key) === k)) continue
          fresh.push(e)
        }
        if (fresh.length > 0) queries.hydrate({ version: 1, entries: fresh })
      }

      /**
       * A read landed: restore from it at startup, and write a held flush over
       * it. A payload that fails to parse counts as read, since writing over
       * it loses nothing. A parse or restore that throws is reported.
       */
      const land = (raw: string | null, restore: boolean): void => {
        let stored: DehydratedEntry[] | undefined
        try {
          stored = parse(raw, buster, maxAgeMs)
          if (restore) hydrate(stored)
        } catch (error) {
          onError(error, 'restore')
        }
        if (held) write(stored)
      }
      const read = (restore: boolean): void => {
        let raw: string | null | Promise<string | null>
        try {
          raw = storage.get(storageKey)
        } catch (error) {
          onError(error, 'restore')
          return
        }
        if (!(raw instanceof Promise)) {
          land(raw, restore)
          return
        }
        reading = true
        host.track(
          raw.then(
            (value) => {
              reading = false
              land(value, restore)
            },
            (error: unknown) => {
              reading = false
              onError(error, 'restore')
            },
          ),
        )
      }

      const flush = (): void => {
        timer = null
        held = true
        if (!reading) read(false)
      }
      const schedule = (): void => {
        if (disposed || timer !== null) return
        if (throttleMs <= 0) {
          flush()
          return
        }
        timer = setTimeout(flush, throttleMs)
      }

      if (options.restore !== false) read(true)

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
          // The entry's server truth, as `dehydrate()` ships it (§13.1). While
          // an optimistic write is live, `event.data` holds the guess, whatever
          // the source: a canonical write under a guess used to store it, and
          // the rollback that corrected it looked like a guess too. So every
          // source is read, and the guess never is.
          const server = event.server
          if (server === undefined || server.data === undefined) return
          // Stamped 0: the server never answered for the entry, as after an
          // optimistic create that committed. `maxAgeMs` has nothing to age it
          // by, and a restore would drop it; a reload fetches it instead.
          if (server.updatedAt === 0) return
          const k = slot(event.query.id, event.key)
          const prev = written.get(k)
          // An optimistic write, or its rollback, leaves the truth as it was:
          // nothing new to write, but a write held by a failed read retries.
          if (
            prev !== undefined &&
            prev.data === server.data &&
            prev.lastUpdatedAt === server.updatedAt
          ) {
            if (held) schedule()
            return
          }
          written.set(k, {
            id: event.query.id,
            key: event.key,
            data: server.data,
            lastUpdatedAt: server.updatedAt,
            ...(server.pageParams !== undefined ? { pageParams: server.pageParams } : {}),
          })
          removed.delete(k)
          schedule()
        },
        onRemove(event) {
          const k = slot(event.query.id, event.key)
          const mine = written.get(k)
          if (mine === undefined) return
          written.delete(k)
          removed.set(k, mine.lastUpdatedAt)
          schedule()
        },
      }
    },
  }
}
