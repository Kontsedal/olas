import type { DevtoolsEmitter } from '../devtools'
import { dispatchError, type ErrorHandler } from '../errors'
import { type Signal, signal } from '../signals'
import { Entry } from './entry'
import { subscribeReconnect, subscribeWindowFocus } from './focus-online'
import { InfiniteEntry, type InfiniteQuery, type InfiniteQuerySpec } from './infinite'
import { stableHash } from './keys'
import {
  type GcEvent,
  type InvalidateEvent,
  lookupRegisteredQuery,
  type QueryClientPlugin,
  type QueryClientPluginApi,
  type SetDataEvent,
} from './plugin'
import type { DehydratedState, Query, QuerySpec, RetryDelay, RetryPolicy, Snapshot } from './types'

const DEFAULT_GC_TIME = 5 * 60_000

type AnyQuery = Query<any, any> & {
  readonly __spec: QuerySpec<any, any>
  __clients: Set<QueryClient>
}

type AnyInfiniteQuery = InfiniteQuery<any, any, any> & {
  readonly __spec: InfiniteQuerySpec<any, any, any, any>
  __clients: Set<QueryClient>
}

export class ClientEntry<T> {
  readonly entry: Entry<T>
  /** The result of `spec.key(...args)` — used for hashing/identity. */
  readonly keyArgs: readonly unknown[]
  /** The original args the consumer passed — what the fetcher receives. */
  readonly callArgs: readonly unknown[]
  readonly client: QueryClient
  readonly query: AnyQuery
  private subscriberCount = 0
  private gcTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private unsubFocus: (() => void) | null = null
  private unsubOnline: (() => void) | null = null
  private gcTime: number
  private refetchInterval: number | undefined
  private refetchOnWindowFocus: boolean
  private refetchOnReconnect: boolean

  constructor(
    client: QueryClient,
    query: AnyQuery,
    callArgs: readonly unknown[],
    keyArgs: readonly unknown[],
    spec: QuerySpec<any, T>,
    hydrated?: { data: T; lastUpdatedAt: number },
  ) {
    this.client = client
    this.query = query
    this.callArgs = callArgs
    this.keyArgs = keyArgs
    this.gcTime = spec.gcTime ?? DEFAULT_GC_TIME
    this.refetchInterval = spec.refetchInterval
    this.refetchOnWindowFocus = spec.refetchOnWindowFocus ?? client.refetchOnWindowFocus
    this.refetchOnReconnect = spec.refetchOnReconnect ?? client.refetchOnReconnect
    const fetcherFn = spec.fetcher
    const deps = client.deps as import('../controller/types').AmbientDeps
    const devtools = client.devtools
    const queryKey = this.keyArgs
    this.entry = new Entry<T>({
      fetcher: () => (signal) => fetcherFn({ signal, deps }, ...(callArgs as never[])),
      staleTime: spec.staleTime,
      retry: spec.retry as RetryPolicy | undefined,
      retryDelay: spec.retryDelay as RetryDelay | undefined,
      initialData: hydrated?.data,
      initialUpdatedAt: hydrated?.lastUpdatedAt,
      events:
        __DEV__ && devtools !== undefined
          ? {
              onFetchStart: () => devtools.emit({ type: 'cache:fetch-start', queryKey }),
              onFetchSuccess: (durationMs) =>
                devtools.emit({ type: 'cache:fetch-success', queryKey, durationMs }),
              onFetchError: (durationMs, error) =>
                devtools.emit({
                  type: 'cache:fetch-error',
                  queryKey,
                  durationMs,
                  error,
                }),
            }
          : undefined,
    })
  }

  acquire(): void {
    this.subscriberCount += 1
    if (this.gcTimer != null) {
      clearTimeout(this.gcTimer)
      this.gcTimer = null
    }
    if (this.subscriberCount === 1) {
      if (this.refetchInterval != null) this.startIntervalTimer()
      if (this.refetchOnWindowFocus) {
        this.unsubFocus = subscribeWindowFocus(() => this.triggerEventRefetch())
      }
      if (this.refetchOnReconnect) {
        this.unsubOnline = subscribeReconnect(() => this.triggerEventRefetch())
      }
    }
  }

  release(): void {
    this.subscriberCount -= 1
    if (this.subscriberCount <= 0) {
      this.stopIntervalTimer()
      this.stopEventSubscriptions()
      if (this.gcTime === 0) {
        this.client.dropEntry(this)
      } else {
        this.gcTimer = setTimeout(() => {
          this.gcTimer = null
          this.client.dropEntry(this)
        }, this.gcTime)
      }
    }
  }

  hasSubscribers(): boolean {
    return this.subscriberCount > 0
  }

  startIntervalTimer(): void {
    if (this.refetchInterval == null) return
    if (this.intervalTimer != null) return
    this.intervalTimer = setInterval(() => {
      this.entry.startFetch().catch(() => {
        /* error already captured on entry */
      })
    }, this.refetchInterval)
  }

  stopIntervalTimer(): void {
    if (this.intervalTimer != null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  stopEventSubscriptions(): void {
    if (this.unsubFocus != null) {
      this.unsubFocus()
      this.unsubFocus = null
    }
    if (this.unsubOnline != null) {
      this.unsubOnline()
      this.unsubOnline = null
    }
  }

  /**
   * Schedule a gc timer for an entry that was just created via a non-subscribing
   * path (`prefetch`, `setData`, `invalidate`). Without this, those entries
   * never trigger `release()` and would live until root dispose. Called by
   * `QueryClient.bindEntry` right after creating a fresh entry; `acquire()`
   * (e.g., from a subscriber that arrives shortly after a prefetch) clears it.
   * No-op if the entry already has subscribers or a gc timer pending.
   */
  scheduleGcIfOrphan(): void {
    if (this.subscriberCount > 0 || this.gcTimer != null) return
    if (this.gcTime === 0) {
      // Defer one microtask so the current caller (e.g. a `setData` that
      // writes then expects to read back in the same tick) sees the entry.
      queueMicrotask(() => {
        if (this.subscriberCount === 0 && this.gcTimer == null) {
          this.client.dropEntry(this)
        }
      })
      return
    }
    this.gcTimer = setTimeout(() => {
      this.gcTimer = null
      this.client.dropEntry(this)
    }, this.gcTime)
  }

  /** Refetch on focus / reconnect, but only if the data is actually stale. */
  private triggerEventRefetch(): void {
    if (!this.entry.isStaleNow()) return
    this.entry.startFetch().catch(() => {
      /* error already captured on entry */
    })
  }

  dispose(): void {
    if (this.gcTimer != null) {
      clearTimeout(this.gcTimer)
      this.gcTimer = null
    }
    this.stopIntervalTimer()
    this.stopEventSubscriptions()
    this.entry.dispose()
  }
}

export class InfiniteClientEntry<TPage, TItem, PageParam> {
  readonly entry: InfiniteEntry<TPage, TItem, PageParam>
  readonly keyArgs: readonly unknown[]
  readonly callArgs: readonly unknown[]
  readonly client: QueryClient
  readonly query: AnyInfiniteQuery
  private subscriberCount = 0
  private gcTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private gcTime: number
  private refetchInterval: number | undefined

  constructor(
    client: QueryClient,
    query: AnyInfiniteQuery,
    callArgs: readonly unknown[],
    keyArgs: readonly unknown[],
    spec: InfiniteQuerySpec<any, PageParam, TPage, TItem>,
  ) {
    this.client = client
    this.query = query
    this.callArgs = callArgs
    this.keyArgs = keyArgs
    this.gcTime = spec.gcTime ?? DEFAULT_GC_TIME
    this.refetchInterval = spec.refetchInterval
    const fetcherFn = spec.fetcher
    const deps = client.deps as import('../controller/types').AmbientDeps
    this.entry = new InfiniteEntry<TPage, TItem, PageParam>({
      fetcher: ({ pageParam, signal }) =>
        fetcherFn({ pageParam, signal, deps }, ...(callArgs as never[])),
      initialPageParam: spec.initialPageParam,
      getNextPageParam: spec.getNextPageParam,
      getPreviousPageParam: spec.getPreviousPageParam,
      itemsOf: spec.itemsOf,
      staleTime: spec.staleTime,
      retry: spec.retry as RetryPolicy | undefined,
      retryDelay: spec.retryDelay as RetryDelay | undefined,
    })
  }

  acquire(): void {
    this.subscriberCount += 1
    if (this.gcTimer != null) {
      clearTimeout(this.gcTimer)
      this.gcTimer = null
    }
    if (this.subscriberCount === 1 && this.refetchInterval != null) {
      this.startIntervalTimer()
    }
  }

  release(): void {
    this.subscriberCount -= 1
    if (this.subscriberCount <= 0) {
      this.stopIntervalTimer()
      if (this.gcTime === 0) {
        this.client.dropInfiniteEntry(
          this as unknown as InfiniteClientEntry<unknown, unknown, unknown>,
        )
      } else {
        this.gcTimer = setTimeout(() => {
          this.gcTimer = null
          this.client.dropInfiniteEntry(
            this as unknown as InfiniteClientEntry<unknown, unknown, unknown>,
          )
        }, this.gcTime)
      }
    }
  }

  private startIntervalTimer(): void {
    if (this.refetchInterval == null || this.intervalTimer != null) return
    this.intervalTimer = setInterval(() => {
      this.entry.startFetch().catch(() => {
        /* error captured on entry */
      })
    }, this.refetchInterval)
  }

  private stopIntervalTimer(): void {
    if (this.intervalTimer != null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  /** See `ClientEntry.scheduleGcIfOrphan`. */
  scheduleGcIfOrphan(): void {
    if (this.subscriberCount > 0 || this.gcTimer != null) return
    if (this.gcTime === 0) {
      queueMicrotask(() => {
        if (this.subscriberCount === 0 && this.gcTimer == null) {
          this.client.dropInfiniteEntry(
            this as unknown as InfiniteClientEntry<unknown, unknown, unknown>,
          )
        }
      })
      return
    }
    this.gcTimer = setTimeout(() => {
      this.gcTimer = null
      this.client.dropInfiniteEntry(
        this as unknown as InfiniteClientEntry<unknown, unknown, unknown>,
      )
    }, this.gcTime)
  }

  dispose(): void {
    if (this.gcTimer != null) {
      clearTimeout(this.gcTimer)
      this.gcTimer = null
    }
    this.stopIntervalTimer()
    this.entry.dispose()
  }
}

/**
 * Per-root entry registry. Owns the keyed `Map<hash, ClientEntry>` per query,
 * GC timers, refetch-interval timers. Subscribers are routed in/out via
 * `acquire` / `release`.
 */
export class QueryClient {
  private readonly maps = new Map<AnyQuery, Map<string, ClientEntry<unknown>>>()
  private readonly infiniteMaps = new Map<
    AnyInfiniteQuery,
    Map<string, InfiniteClientEntry<unknown, unknown, unknown>>
  >()
  private readonly touchedQueries = new Set<AnyQuery>()
  private readonly touchedInfiniteQueries = new Set<AnyInfiniteQuery>()
  private readonly hydratedData = new Map<string, { data: unknown; lastUpdatedAt: number }>()
  /** Mutations inflight across the whole root — used by `waitForIdle`. */
  readonly mutationsInflight$: Signal<number> = signal(0)
  private onError: ErrorHandler | undefined
  private disposed = false
  /** Devtools bus, if any — passed by `createRoot`. Used to emit cache events. */
  readonly devtools: DevtoolsEmitter | undefined

  /** Root-level deps; passed to every `QuerySpec.fetcher` via `FetchCtx`. */
  readonly deps: Record<string, unknown>

  /** Root-wide defaults for refetch triggers; per-query spec overrides win. Spec §5.9. */
  readonly refetchOnWindowFocus: boolean
  readonly refetchOnReconnect: boolean

  /**
   * Installed plugins. Fired on every `setData` / `invalidate` / `gc` so
   * cross-tab / persistence-like layers can observe and react. SPEC §13.2.
   */
  private readonly plugins: QueryClientPlugin[]
  /**
   * Flipped to `true` while a remote-originated write (via
   * `applyRemoteSetData` / `applyRemoteInvalidate`) is being applied. The
   * resulting plugin events carry `isRemote: true` so plugins know to skip
   * rebroadcast.
   */
  private applyingRemote = false

  constructor(opts?: {
    onError?: ErrorHandler
    hydrate?: DehydratedState
    devtools?: DevtoolsEmitter
    deps?: Record<string, unknown>
    refetchOnWindowFocus?: boolean
    refetchOnReconnect?: boolean
    plugins?: QueryClientPlugin[]
  }) {
    this.onError = opts?.onError
    this.devtools = opts?.devtools
    this.deps = opts?.deps ?? {}
    this.refetchOnWindowFocus = opts?.refetchOnWindowFocus ?? false
    this.refetchOnReconnect = opts?.refetchOnReconnect ?? false
    this.plugins = opts?.plugins ?? []
    if (opts?.hydrate) this.hydrate(opts.hydrate)
    const api = this.makePluginApi()
    for (const plugin of this.plugins) {
      this.callPlugin(() => plugin.init?.(api))
    }
  }

  /**
   * Build the `QueryClientPluginApi` view that plugins receive at `init`
   * time. Closes over `this`; safe to hand out — plugins call back through
   * these methods to push remote-originated writes into the local cache.
   */
  private makePluginApi(): QueryClientPluginApi {
    const self = this
    return {
      applyRemoteSetData(queryId, keyArgs, data) {
        self.applyRemoteSetData(queryId, keyArgs, data)
      },
      applyRemoteInvalidate(queryId, keyArgs) {
        self.applyRemoteInvalidate(queryId, keyArgs)
      },
      subscribedKeys(queryId) {
        return self.subscribedKeysFor(queryId)
      },
    }
  }

  /** Invoke a plugin callback; route exceptions through `onError`. */
  private callPlugin(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      dispatchError(this.onError, err, {
        kind: 'plugin',
        controllerPath: [],
      })
    }
  }

  private emitSetData(
    query: AnyQuery | AnyInfiniteQuery,
    keyArgs: readonly unknown[],
    data: unknown,
    kind: 'data' | 'infinite',
  ): void {
    if (this.plugins.length === 0) return
    const queryId = query.__spec.queryId
    if (queryId == null) return
    const event: SetDataEvent = {
      queryId,
      keyArgs,
      data,
      kind,
      isRemote: this.applyingRemote,
    }
    for (const plugin of this.plugins) {
      if (plugin.onSetData) {
        const cb = plugin.onSetData
        this.callPlugin(() => cb.call(plugin, event))
      }
    }
  }

  private emitInvalidate(
    query: AnyQuery | AnyInfiniteQuery,
    keyArgs: readonly unknown[],
    kind: 'data' | 'infinite',
  ): void {
    if (this.plugins.length === 0) return
    const queryId = query.__spec.queryId
    if (queryId == null) return
    const event: InvalidateEvent = {
      queryId,
      keyArgs,
      kind,
      isRemote: this.applyingRemote,
    }
    for (const plugin of this.plugins) {
      if (plugin.onInvalidate) {
        const cb = plugin.onInvalidate
        this.callPlugin(() => cb.call(plugin, event))
      }
    }
  }

  private emitGc(
    query: AnyQuery | AnyInfiniteQuery,
    keyArgs: readonly unknown[],
    kind: 'data' | 'infinite',
  ): void {
    if (this.plugins.length === 0) return
    const queryId = query.__spec.queryId
    if (queryId == null) return
    const event: GcEvent = { queryId, keyArgs, kind }
    for (const plugin of this.plugins) {
      if (plugin.onGc) {
        const cb = plugin.onGc
        this.callPlugin(() => cb.call(plugin, event))
      }
    }
  }

  /** Resolve `queryId → live entry-map keys`. Empty array when unknown. */
  private subscribedKeysFor(queryId: string): readonly (readonly unknown[])[] {
    // Defer the registry lookup to avoid an eager circular import — `define.ts`
    // imports `QueryClient` as a type, and we import the registry helper here
    // for runtime use only.
    const query = lookupRegisteredQuery(queryId)
    if (!query) return []
    const out: (readonly unknown[])[] = []
    if (query.__olas === 'query') {
      const map = this.maps.get(query as unknown as AnyQuery)
      if (map) for (const ce of map.values()) out.push(ce.keyArgs)
    } else {
      const map = this.infiniteMaps.get(query as unknown as AnyInfiniteQuery)
      if (map) for (const ce of map.values()) out.push(ce.keyArgs)
    }
    return out
  }

  /**
   * Apply a remote-originated `setData` for the query identified by
   * `queryId`, scoped to the entry already keyed by `keyArgs` in this
   * client. Goes through the underlying `Entry.setData` so subscribers see
   * the write; plugin `onSetData` fires with `isRemote: true`.
   *
   * Drops silently when:
   * - No query with that id is registered (the receiving tab hasn't
   *   imported the module that defined it).
   * - The registered query is an infinite query (cross-tab infinite sync
   *   is deferred — see `plugin.ts` `SetDataEvent.kind`).
   * - No local entry exists for that key (the receiving tab isn't
   *   subscribed; nothing useful to write to without callArgs for a
   *   future refetch).
   */
  applyRemoteSetData(queryId: string, keyArgs: readonly unknown[], data: unknown): void {
    const query = lookupRegisteredQuery(queryId)
    if (!query) return
    if (query.__olas !== 'query') return // infinite — deferred for v1
    const internal = query as unknown as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return
    const hash = stableHash(keyArgs)
    const entry = map.get(hash)
    if (!entry) return
    this.applyingRemote = true
    try {
      entry.entry.setData(() => data as never)
      this.emitSetData(internal, entry.keyArgs, data, 'data')
    } finally {
      this.applyingRemote = false
    }
  }

  applyRemoteInvalidate(queryId: string, keyArgs: readonly unknown[]): void {
    const query = lookupRegisteredQuery(queryId)
    if (!query) return
    if (query.__olas !== 'query') return // infinite — deferred for v1
    const internal = query as unknown as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return
    const hash = stableHash(keyArgs)
    const entry = map.get(hash)
    if (!entry) return
    this.applyingRemote = true
    try {
      // Emit AFTER kicking off invalidate so plugins reading entry state see
      // post-invalidation values, mirroring setData's emit-after-write order.
      entry.entry.invalidate().catch((err) => {
        dispatchError(this.onError, err, {
          kind: 'cache',
          controllerPath: [],
          queryKey: entry.keyArgs,
        })
      })
      this.emitInvalidate(internal, entry.keyArgs, 'data')
    } finally {
      this.applyingRemote = false
    }
  }

  hydrate(state: DehydratedState): void {
    if (state.version !== 1) return
    for (const entry of state.entries) {
      const hash = stableHash(entry.key)
      this.hydratedData.set(hash, {
        data: entry.data,
        lastUpdatedAt: entry.lastUpdatedAt,
      })
    }
  }

  /**
   * Snapshot every live cache entry (regular + infinite) as a flat list of
   * `DebugCacheEntry`. Exposed via `root.__debug.queryEntries()` for the
   * devtools cache inspector — shows current data and state, not past
   * fetch events. Spec §20.9.
   */
  queryEntriesSnapshot(): import('../devtools').DebugCacheEntry[] {
    const out: import('../devtools').DebugCacheEntry[] = []
    for (const map of this.maps.values()) {
      for (const ce of map.values()) {
        out.push({
          key: ce.keyArgs as readonly unknown[],
          status: ce.entry.status.peek(),
          data: ce.entry.data.peek(),
          error: ce.entry.error.peek(),
          lastUpdatedAt: ce.entry.lastUpdatedAt.peek(),
          isStale: ce.entry.isStale.peek(),
          isFetching: ce.entry.isFetching.peek(),
          hasPendingMutations: ce.entry.hasPendingMutations.peek(),
        })
      }
    }
    for (const map of this.infiniteMaps.values()) {
      for (const ce of map.values()) {
        out.push({
          key: ce.keyArgs as readonly unknown[],
          status: ce.entry.status.peek(),
          // Infinite entries carry an array of pages; expose them verbatim.
          data: ce.entry.pages.peek(),
          error: ce.entry.error.peek(),
          lastUpdatedAt: ce.entry.lastUpdatedAt.peek(),
          isStale: ce.entry.isStale.peek(),
          isFetching: ce.entry.isFetching.peek(),
          hasPendingMutations: ce.entry.hasPendingMutations.peek(),
        })
      }
    }
    return out
  }

  dehydrate(): DehydratedState {
    const entries: DehydratedState['entries'] = []
    for (const map of this.maps.values()) {
      for (const ce of map.values()) {
        if (ce.entry.status.peek() === 'success') {
          entries.push({
            key: ce.keyArgs,
            data: ce.entry.data.peek(),
            lastUpdatedAt: ce.entry.lastUpdatedAt.peek() ?? Date.now(),
          })
        }
      }
    }
    return { version: 1, entries }
  }

  async waitForIdle(): Promise<void> {
    for (let safety = 0; safety < 100; safety++) {
      const tasks: Promise<void>[] = []
      for (const map of this.maps.values()) {
        for (const ce of map.values()) {
          if (ce.entry.isFetching.peek()) {
            tasks.push(waitUntilFalse(ce.entry.isFetching))
          }
        }
      }
      for (const map of this.infiniteMaps.values()) {
        for (const ce of map.values()) {
          if (ce.entry.isFetching.peek()) {
            tasks.push(waitUntilFalse(ce.entry.isFetching))
          }
        }
      }
      if (this.mutationsInflight$.peek() > 0) {
        tasks.push(
          new Promise<void>((resolve) => {
            const unsub = this.mutationsInflight$.subscribe((v) => {
              if (v === 0) {
                unsub()
                resolve()
              }
            })
          }),
        )
      }
      if (tasks.length === 0) return
      await Promise.all(tasks)
    }
  }

  bindEntry<Args extends unknown[], T>(query: Query<Args, T>, args: Args): ClientEntry<T> {
    const internal = query as AnyQuery
    let map = this.maps.get(internal)
    if (!map) {
      map = new Map()
      this.maps.set(internal, map)
      this.touchedQueries.add(internal)
      internal.__clients.add(this)
    }
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    let entry = map.get(hash) as ClientEntry<T> | undefined
    if (!entry) {
      const hydrated = this.hydratedData.get(hash) as { data: T; lastUpdatedAt: number } | undefined
      if (hydrated) this.hydratedData.delete(hash)
      entry = new ClientEntry<T>(this, internal, args, keyArgs, internal.__spec, hydrated)
      map.set(hash, entry as ClientEntry<unknown>)
      // The entry is created without an immediate subscriber (callers like
      // `prefetch`/`setData`/`invalidate` reach `bindEntry` first; subscribing
      // callers then call `acquire()` right after, which clears the gc timer).
      entry.scheduleGcIfOrphan()
    }
    return entry
  }

  dropEntry(entry: ClientEntry<unknown>): void {
    const map = this.maps.get(entry.query)
    if (!map) return
    const hash = stableHash(entry.keyArgs)
    if (map.get(hash) !== entry) return
    map.delete(hash)
    entry.dispose()
    if (map.size === 0) {
      this.maps.delete(entry.query)
    }
    if (__DEV__) {
      this.devtools?.emit({ type: 'cache:gc', queryKey: entry.keyArgs })
    }
    this.emitGc(entry.query, entry.keyArgs, 'data')
  }

  invalidate<Args extends unknown[]>(query: Query<Args, any>, args: Args): void {
    const internal = query as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    const entry = map.get(hash)
    if (!entry) return
    if (__DEV__) {
      this.devtools?.emit({ type: 'cache:invalidated', queryKey: keyArgs })
    }
    entry.entry.invalidate().catch((err) => {
      dispatchError(this.onError, err, {
        kind: 'cache',
        controllerPath: [],
        queryKey: keyArgs,
      })
    })
    this.emitInvalidate(internal, keyArgs, 'data')
  }

  invalidateAll(query: Query<any, any>): void {
    const internal = query as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return
    for (const [hash, entry] of map) {
      void hash
      if (__DEV__) {
        this.devtools?.emit({ type: 'cache:invalidated', queryKey: entry.keyArgs })
      }
      entry.entry.invalidate().catch((err) => {
        dispatchError(this.onError, err, {
          kind: 'cache',
          controllerPath: [],
          queryKey: entry.keyArgs,
        })
      })
      this.emitInvalidate(internal, entry.keyArgs, 'data')
    }
  }

  setData<Args extends unknown[], T>(
    query: Query<Args, T>,
    args: Args,
    updater: (prev: T | undefined) => T,
  ): Snapshot {
    const entry = this.bindEntry(query, args)
    const snapshot = entry.entry.setData(updater)
    // Read the post-update value to broadcast — plugins want the new state,
    // not the updater function (which would be uncloneable across
    // BroadcastChannel).
    this.emitSetData(entry.query, entry.keyArgs, entry.entry.data.peek(), 'data')
    return snapshot
  }

  bindInfiniteEntry<Args extends unknown[], TPage, TItem>(
    query: InfiniteQuery<Args, TPage, TItem>,
    args: Args,
  ): InfiniteClientEntry<TPage, TItem, unknown> {
    const internal = query as AnyInfiniteQuery
    let map = this.infiniteMaps.get(internal)
    if (!map) {
      map = new Map()
      this.infiniteMaps.set(internal, map)
      this.touchedInfiniteQueries.add(internal)
      internal.__clients.add(this)
    }
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    let entry = map.get(hash) as InfiniteClientEntry<TPage, TItem, unknown> | undefined
    if (!entry) {
      entry = new InfiniteClientEntry<TPage, TItem, unknown>(
        this,
        internal,
        args,
        keyArgs,
        internal.__spec,
      )
      map.set(hash, entry as InfiniteClientEntry<unknown, unknown, unknown>)
      entry.scheduleGcIfOrphan()
    }
    return entry
  }

  dropInfiniteEntry(entry: InfiniteClientEntry<unknown, unknown, unknown>): void {
    const map = this.infiniteMaps.get(entry.query)
    if (!map) return
    const hash = stableHash(entry.keyArgs)
    if (map.get(hash) !== entry) return
    map.delete(hash)
    entry.dispose()
    if (map.size === 0) {
      this.infiniteMaps.delete(entry.query)
    }
    this.emitGc(entry.query, entry.keyArgs, 'infinite')
  }

  invalidateInfinite<Args extends unknown[]>(
    query: InfiniteQuery<Args, any, any>,
    args: Args,
  ): void {
    const internal = query as AnyInfiniteQuery
    const map = this.infiniteMaps.get(internal)
    if (!map) return
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    const entry = map.get(hash)
    if (!entry) return
    entry.entry.invalidate().catch((err) => {
      dispatchError(this.onError, err, {
        kind: 'cache',
        controllerPath: [],
        queryKey: entry.keyArgs,
      })
    })
    this.emitInvalidate(internal, keyArgs, 'infinite')
  }

  invalidateAllInfinite(query: InfiniteQuery<any, any, any>): void {
    const internal = query as AnyInfiniteQuery
    const map = this.infiniteMaps.get(internal)
    if (!map) return
    for (const entry of map.values()) {
      entry.entry.invalidate().catch((err) => {
        dispatchError(this.onError, err, {
          kind: 'cache',
          controllerPath: [],
          queryKey: entry.keyArgs,
        })
      })
      this.emitInvalidate(internal, entry.keyArgs, 'infinite')
    }
  }

  setInfiniteData<Args extends unknown[], TPage>(
    query: InfiniteQuery<Args, TPage, any>,
    args: Args,
    updater: (prev: TPage[] | undefined) => TPage[],
  ): Snapshot {
    const entry = this.bindInfiniteEntry(query, args)
    const snapshot = entry.entry.setData(updater)
    this.emitSetData(entry.query, entry.keyArgs, entry.entry.pages.peek(), 'infinite')
    return snapshot
  }

  prefetchInfinite<Args extends unknown[], TPage>(
    query: InfiniteQuery<Args, TPage, any>,
    args: Args,
  ): Promise<TPage> {
    const entry = this.bindInfiniteEntry(query, args)
    // Acquire/release wraps the fetch so the entry isn't gc'd mid-flight by
    // the orphan-gc timer scheduled in `bindInfiniteEntry`.
    entry.acquire()
    const promise = (async () => {
      const status = entry.entry.status.peek()
      if (status === 'success' && !entry.entry.isStaleNow()) {
        return entry.entry.pages.peek()[0] as TPage
      }
      return entry.entry.startFetch()
    })()
    return promise.finally(() => entry.release())
  }

  prefetch<Args extends unknown[], T>(query: Query<Args, T>, args: Args): Promise<T> {
    const entry = this.bindEntry(query, args)
    entry.acquire()
    const promise = (async () => {
      const status = entry.entry.status.peek()
      if (status === 'success' && !entry.entry.isStaleNow()) {
        return entry.entry.data.peek() as T
      }
      if (entry.entry.isFetching.peek()) {
        return entry.entry.firstValue()
      }
      return entry.entry.startFetch()
    })()
    return promise.finally(() => entry.release())
  }

  inflightCount(): number {
    let count = 0
    for (const [, map] of this.maps) {
      for (const [, entry] of map) {
        if (entry.entry.isFetching.peek()) count++
      }
    }
    return count
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const map of this.maps.values()) {
      for (const entry of map.values()) {
        entry.dispose()
      }
    }
    this.maps.clear()
    for (const map of this.infiniteMaps.values()) {
      for (const entry of map.values()) {
        entry.dispose()
      }
    }
    this.infiniteMaps.clear()
    for (const q of this.touchedQueries) {
      q.__clients.delete(this)
    }
    this.touchedQueries.clear()
    for (const q of this.touchedInfiniteQueries) {
      q.__clients.delete(this)
    }
    this.touchedInfiniteQueries.clear()
    this.hydratedData.clear()
    for (const plugin of this.plugins) {
      if (plugin.dispose) {
        const cb = plugin.dispose
        this.callPlugin(() => cb.call(plugin))
      }
    }
  }
}

function waitUntilFalse(sig: {
  peek(): boolean
  subscribe(h: (v: boolean) => void): () => void
}): Promise<void> {
  if (!sig.peek()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const unsub = sig.subscribe((v) => {
      if (!v) {
        unsub()
        resolve()
      }
    })
  })
}
