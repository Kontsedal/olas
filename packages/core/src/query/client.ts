import { __currentCauseId, type DevtoolsEmitter } from '../devtools'
import { dispatchError, type ErrorHandler } from '../errors'
import { scheduleExpiry } from '../expiry-timer'
import type { PluginEngine, PluginSet } from '../plugin/host'
import type { FetchContext, MutationHost, QueryHost, QueryRef, WriteSource } from '../plugin/types'
import { type Signal, signal } from '../signals'
import { isAbortError } from '../utils'
import { createInfiniteQueryActions, createQueryActions } from './actions'
import { Entry } from './entry'
import { subscribeReconnect, subscribeWindowFocus } from './focus-online'
import {
  InfiniteEntry,
  type InfiniteQuery,
  type InfiniteQueryActions,
  type InfiniteQuerySpec,
} from './infinite'
import { stableHash } from './keys'
import {
  createMutation as createMutationImpl,
  type Mutation,
  type MutationLifecycleHooks,
  type MutationSpec,
} from './mutation'
import { lookupRegisteredMutation } from './mutation-registry'
import type {
  DehydratedState,
  Query,
  QueryActions,
  QueryDefaults,
  QuerySpec,
  RefetchInterval,
  RetryDelay,
  RetryPolicy,
  Snapshot,
} from './types'

const DEFAULT_GC_TIME = 5 * 60_000

/**
 * Resolve the gap before the next interval tick. The function form is called
 * fresh on every scheduling decision with the entry's latest data — see
 * `RefetchInterval`.
 *
 * `readData` is a thunk rather than a value so the read happens *inside* the
 * try: `entry.data` is a signal on regular entries but a `computed` on infinite
 * ones, and a computed can throw. Everything evaluated before the chain re-arms
 * has to be total, or the throw ends polling for the entry permanently.
 * (Unreachable today — neither `data` implementation can throw — but the
 * argument-position read was the one expression left outside the guard.) The
 * read is a `peek()`, so resolution never becomes a reactive dependency.
 *
 * Returns `null` for anything that isn't a positive finite number — and for a
 * thunk that throws — which stops the chain. The alternative on a `0` / `NaN`
 * value is scheduling `setTimeout(fn, 0)`: a fetch-per-macrotask hot loop that
 * presents as a hung tab, not as a config error. Both failure modes stop the
 * chain loudly instead, with a warning that says which one happened. The
 * warning fires once per stop, and a misconfigured entry re-warns on each
 * 0→1 acquire (a StrictMode double-mount shows two) — dev-only and benign.
 */
function resolveRefetchInterval<T>(
  spec: RefetchInterval<T>,
  readData: () => T | undefined,
): number | null {
  let ms: unknown
  if (typeof spec === 'function') {
    try {
      ms = spec(readData())
    } catch (err) {
      if (__DEV__) {
        console.warn(
          '[olas] refetchInterval thunk threw — it must return a positive finite number. ' +
            'Refetch polling for this cache entry has stopped; it restarts only when the ' +
            'entry loses every subscriber and gains a new one.',
          err,
        )
      }
      return null
    }
  } else {
    ms = spec
  }
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return ms
  if (__DEV__) {
    console.warn(
      `[olas] refetchInterval resolved to ${String(ms)} — expected a positive finite number. ` +
        'Refetch polling for this cache entry has stopped; it restarts only when the entry ' +
        'loses every subscriber and gains a new one.',
    )
  }
  return null
}

type AnyQuery = Query<any, any> & {
  readonly __spec: QuerySpec<any, any>
  readonly __id: string
  __clients: Set<QueryClient>
}

type AnyInfiniteQuery = InfiniteQuery<any, any, any> & {
  readonly __spec: InfiniteQuerySpec<any, any, any, any>
  readonly __id: string
  __clients: Set<QueryClient>
}

/**
 * Composite hydration-buffer key: query identity + key hash. Namespacing by
 * identity stops a dehydrated entry for query A being adopted by query B that
 * merely hashes to the same key (spec §15, T1.2). `JSON.stringify` of the pair
 * is used rather than string concatenation so no separator char is ambiguous —
 * both `id` (an arbitrary user-written string) and `hash` are unbounded.
 */
const hydrationKey = (id: string, hash: string): string => JSON.stringify([id, hash])

/** Options for `bindQuery(ctx, query, options?)` and `root.bindQuery(query, options?)`. */
export type BindQueryOptions = {
  /**
   * Stamped as `origin` on every write and invalidation made through this
   * handle, so plugins can tell them apart from the app's own. A realtime
   * patcher tags its writes this way, and cross-tab then leaves them alone:
   * every tab receives the same server push itself.
   */
  origin?: string
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
  /** Cancellation closure from `scheduleExpiry`; `null` = no gc pending. */
  private gcTimer: (() => void) | null = null
  /** Cancellation closure from `scheduleExpiry`; `null` = chain stopped. */
  private intervalTimer: (() => void) | null = null
  private unsubFocus: (() => void) | null = null
  private unsubOnline: (() => void) | null = null
  private gcTime: number
  /**
   * Resolves the gap before the next interval tick — `null` to stop the
   * chain, `undefined` when the query declared no `refetchInterval` at all.
   *
   * Held as a closure rather than as the raw `RefetchInterval<T>` spec field
   * on purpose: a `(data: T | undefined) => number` member puts `T` in a
   * contravariant position and makes `ClientEntry<T>` invariant, which breaks
   * every `ClientEntry<unknown>` boundary in this file (the entry maps,
   * `dropEntry`). The closure keeps `T` internal.
   */
  private nextIntervalMs: (() => number | null) | undefined
  private refetchOnWindowFocus: boolean
  private refetchOnReconnect: boolean

  constructor(
    client: QueryClient,
    query: AnyQuery,
    callArgs: readonly unknown[],
    keyArgs: readonly unknown[],
    spec: QuerySpec<any, T>,
    hydrated: { data: T; lastUpdatedAt: number } | undefined,
    /**
     * Prepared by `QueryClient.bindEntry` (the only construction site): reports
     * a successful fetch to the plugins as a `'fetch'` write. Handed in
     * pre-built so the client's emitters stay private.
     */
    onFetched: (data: T) => void,
  ) {
    this.client = client
    this.query = query
    this.callArgs = callArgs
    this.keyArgs = keyArgs
    const defaults = client.defaults
    this.gcTime = spec.gcTime ?? defaults.gcTime ?? DEFAULT_GC_TIME
    const interval = spec.refetchInterval
    this.nextIntervalMs =
      interval === undefined
        ? undefined
        : () => resolveRefetchInterval(interval, () => this.entry.data.peek())
    this.refetchOnWindowFocus = spec.refetchOnWindowFocus ?? client.refetchOnWindowFocus
    this.refetchOnReconnect = spec.refetchOnReconnect ?? client.refetchOnReconnect
    const fetcherFn = spec.fetcher
    const deps = client.deps as import('../controller/types').AmbientDeps
    const devtools = client.devtools
    const queryKey = this.keyArgs
    const ref = client.refOf(query)
    this.entry = new Entry<T>({
      fetcher: () => (signal, attempt) =>
        client.runFetch({ query: ref, key: keyArgs, args: callArgs, signal, attempt }, () =>
          fetcherFn({ signal, deps }, ...(callArgs as never[])),
        ) as Promise<T>,
      staleTime: spec.staleTime ?? defaults.staleTime,
      retry: (spec.retry ?? defaults.retry) as RetryPolicy | undefined,
      retryDelay: (spec.retryDelay ?? defaults.retryDelay) as RetryDelay | undefined,
      networkMode: spec.networkMode ?? defaults.networkMode,
      structuralShare: spec.structuralShare ?? defaults.structuralShare,
      initialData: hydrated?.data,
      initialUpdatedAt: hydrated?.lastUpdatedAt,
      events:
        __DEV__ && devtools !== undefined
          ? {
              onFetchStart: (fetchId) =>
                devtools.emit({ type: 'cache:fetch-start', queryKey, causeId: fetchId }),
              onFetchSuccess: (durationMs, data, fetchId) => {
                devtools.emit({
                  type: 'cache:fetch-success',
                  queryKey,
                  durationMs,
                  causeId: fetchId,
                })
                // The data write the fetch produced — correlated with the
                // fetch via `causeId` so the timeline groups them and the
                // cache inspector updates without polling.
                devtools.emit({
                  type: 'cache:set-data',
                  queryKey,
                  source: 'fetch',
                  data,
                  causeId: fetchId,
                })
              },
              onFetchError: (durationMs, error, fetchId) =>
                devtools.emit({
                  type: 'cache:fetch-error',
                  queryKey,
                  durationMs,
                  error,
                  causeId: fetchId,
                }),
              // Optimistic snapshot layer events. `causeId` is read from the
              // ambient cause (the mutation run whose `onMutate`/rollback is
              // executing) at emit time — see `__runWithCause` in devtools.ts.
              onSnapshotPush: () =>
                devtools.emit({ type: 'snapshot:push', queryKey, causeId: __currentCauseId() }),
              onSnapshotRollback: () =>
                devtools.emit({ type: 'snapshot:rollback', queryKey, causeId: __currentCauseId() }),
              onSnapshotFinalize: () =>
                devtools.emit({ type: 'snapshot:finalize', queryKey, causeId: __currentCauseId() }),
            }
          : undefined,
      onSuccessData: onFetched,
    })
  }

  acquire(): void {
    this.subscriberCount += 1
    if (this.gcTimer != null) {
      this.gcTimer()
      this.gcTimer = null
    }
    if (this.subscriberCount === 1) {
      this.client.emitActivity(this.query, this.keyArgs, true)
      if (this.nextIntervalMs !== undefined) this.startIntervalTimer()
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
      if (this.subscriberCount === 0) this.client.emitActivity(this.query, this.keyArgs, false)
      this.stopIntervalTimer()
      this.stopEventSubscriptions()
      if (this.gcTime === 0) {
        this.client.dropEntry(this)
      } else {
        this.gcTimer = scheduleExpiry(this.gcTime, () => {
          this.gcTimer = null
          this.client.dropEntry(this)
        })
      }
    }
  }

  hasSubscribers(): boolean {
    return this.subscriberCount > 0
  }

  startIntervalTimer(): void {
    if (this.nextIntervalMs === undefined) return
    if (this.intervalTimer != null) return
    this.armIntervalTick()
  }

  /**
   * One link of the refetch chain. A self-rescheduling `setTimeout` rather
   * than `setInterval` because the gap is re-resolved before every tick —
   * that's what lets `refetchInterval` be a function of the entry's data
   * (`RefetchInterval`, spec §5.9). For the number form the two are
   * equivalent.
   */
  private armIntervalTick(): void {
    const ms = this.nextIntervalMs?.()
    if (ms == null) {
      this.intervalTimer = null
      return
    }
    // `scheduleExpiry` rather than a raw `setTimeout`: `resolveRefetchInterval`
    // rejects non-finite gaps, but a FINITE one above the signed 32-bit limit
    // still overflows into an immediate fire — a ~1ms poll storm out of the
    // longest interval you can ask for. Chunking is the same fix staleness and
    // gc use (§21.5).
    this.intervalTimer = scheduleExpiry(ms, () => {
      // Re-arm BEFORE the guards and the fetch, so the cadence stays a
      // metronome: gap N+1 is measured from this tick, not from whenever the
      // fetch it kicks off happens to settle. `setInterval` behaved that way
      // and the tests pin it — a fetch slower than the interval must not
      // stretch the schedule.
      this.armIntervalTick()
      // Skip when the tab is hidden — refetching while in background wastes
      // battery and network. `refetchOnWindowFocus` (when enabled) will
      // catch the entry up on visibility return; pure-interval users without
      // focus-refetch get the catch-up via `acquire()` re-arming the timer
      // when they next mount.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }
      // Join an in-flight fetch instead of aborting it. `startFetch()` aborts
      // the current request, so a fetch slower than the interval would
      // livelock — abort→restart every tick, never completing, hammering one
      // aborted request per interval (T3.2). Skip the tick; the running fetch
      // will finish and the next tick re-arms once it's idle.
      if (this.entry.isFetching.peek()) return
      this.entry.startFetch().catch(() => {
        /* error already captured on entry */
      })
    })
  }

  stopIntervalTimer(): void {
    if (this.intervalTimer != null) {
      this.intervalTimer()
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
    this.gcTimer = scheduleExpiry(this.gcTime, () => {
      this.gcTimer = null
      this.client.dropEntry(this)
    })
  }

  /** Refetch on focus / reconnect, but only if the data is actually stale. */
  private triggerEventRefetch(): void {
    if (!this.entry.isStaleNow()) return
    // Join an in-flight fetch instead of aborting + restarting it — a focus /
    // reconnect landing mid-fetch shouldn't cancel it (T3.9, cf. T3.2 interval).
    if (this.entry.isFetching.peek()) return
    this.entry.startFetch().catch(() => {
      /* error already captured on entry */
    })
  }

  dispose(): void {
    if (this.gcTimer != null) {
      this.gcTimer()
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
  /** Cancellation closure from `scheduleExpiry`; `null` = no gc pending. */
  private gcTimer: (() => void) | null = null
  /** Cancellation closure from `scheduleExpiry`; `null` = chain stopped. */
  private intervalTimer: (() => void) | null = null
  private gcTime: number
  /** See `ClientEntry.nextIntervalMs` — same closure, same variance reason. */
  private nextIntervalMs: (() => number | null) | undefined

  constructor(
    client: QueryClient,
    query: AnyInfiniteQuery,
    callArgs: readonly unknown[],
    keyArgs: readonly unknown[],
    spec: InfiniteQuerySpec<any, PageParam, TPage, TItem>,
    /** Reports every successful page batch as a `'fetch'` write. See `ClientEntry`. */
    onFetched: (pages: TPage[]) => void,
  ) {
    this.client = client
    this.query = query
    this.callArgs = callArgs
    this.keyArgs = keyArgs
    // `refetchOnWindowFocus` / `refetchOnReconnect` are intentionally absent:
    // infinite entries install no focus/online subscription, so honoring a
    // root default here would be dead config. See `QueryDefaults`.
    const defaults = client.defaults
    this.gcTime = spec.gcTime ?? defaults.gcTime ?? DEFAULT_GC_TIME
    const interval = spec.refetchInterval
    this.nextIntervalMs =
      interval === undefined
        ? undefined
        : () => resolveRefetchInterval(interval, () => this.entry.data.peek())
    const fetcherFn = spec.fetcher
    const deps = client.deps as import('../controller/types').AmbientDeps
    const ref = client.refOf(query)
    this.entry = new InfiniteEntry<TPage, TItem, PageParam>({
      fetcher: ({ pageParam, signal, attempt }) =>
        client.runFetch(
          { query: ref, key: keyArgs, args: callArgs, pageParam, signal, attempt },
          () => fetcherFn({ pageParam, signal, deps }, ...(callArgs as never[])),
        ) as Promise<TPage>,
      initialPageParam: spec.initialPageParam,
      getNextPageParam: spec.getNextPageParam,
      getPreviousPageParam: spec.getPreviousPageParam,
      itemsOf: spec.itemsOf,
      staleTime: spec.staleTime ?? defaults.staleTime,
      retry: (spec.retry ?? defaults.retry) as RetryPolicy | undefined,
      retryDelay: (spec.retryDelay ?? defaults.retryDelay) as RetryDelay | undefined,
      networkMode: spec.networkMode ?? defaults.networkMode,
      structuralShare: spec.structuralShare ?? defaults.structuralShare,
      onSuccessData: onFetched,
    })
  }

  acquire(): void {
    this.subscriberCount += 1
    if (this.gcTimer != null) {
      this.gcTimer()
      this.gcTimer = null
    }
    if (this.subscriberCount === 1) {
      this.client.emitActivity(this.query, this.keyArgs, true)
      if (this.nextIntervalMs !== undefined) this.startIntervalTimer()
    }
  }

  hasSubscribers(): boolean {
    return this.subscriberCount > 0
  }

  release(): void {
    this.subscriberCount -= 1
    if (this.subscriberCount <= 0) {
      if (this.subscriberCount === 0) this.client.emitActivity(this.query, this.keyArgs, false)
      this.stopIntervalTimer()
      if (this.gcTime === 0) {
        this.client.dropInfiniteEntry(
          this as unknown as InfiniteClientEntry<unknown, unknown, unknown>,
        )
      } else {
        this.gcTimer = scheduleExpiry(this.gcTime, () => {
          this.gcTimer = null
          this.client.dropInfiniteEntry(
            this as unknown as InfiniteClientEntry<unknown, unknown, unknown>,
          )
        })
      }
    }
  }

  private startIntervalTimer(): void {
    if (this.nextIntervalMs === undefined || this.intervalTimer != null) return
    this.armIntervalTick()
  }

  /**
   * Same self-rescheduling chain as `ClientEntry.armIntervalTick` — see there
   * for why it's a `setTimeout` chain and why the re-arm comes first. The one
   * difference: the thunk's argument is the entry's pages array
   * (`TPage[] | undefined`), since that's what an infinite entry stores.
   */
  private armIntervalTick(): void {
    const ms = this.nextIntervalMs?.()
    if (ms == null) {
      this.intervalTimer = null
      return
    }
    this.intervalTimer = scheduleExpiry(ms, () => {
      this.armIntervalTick()
      // Same visibility-gate as the regular `ClientEntry.startIntervalTimer`.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }
      // Join an in-flight fetch instead of aborting it (T3.2) — see the
      // regular `ClientEntry.startIntervalTimer` for the livelock rationale.
      if (this.entry.isFetching.peek()) return
      this.entry.startFetch().catch(() => {
        /* error captured on entry */
      })
    })
  }

  private stopIntervalTimer(): void {
    if (this.intervalTimer != null) {
      this.intervalTimer()
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
    this.gcTimer = scheduleExpiry(this.gcTime, () => {
      this.gcTimer = null
      this.client.dropInfiniteEntry(
        this as unknown as InfiniteClientEntry<unknown, unknown, unknown>,
      )
    })
  }

  dispose(): void {
    if (this.gcTimer != null) {
      this.gcTimer()
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
export class QueryClient implements PluginEngine {
  private readonly maps = new Map<AnyQuery, Map<string, ClientEntry<unknown>>>()
  private readonly infiniteMaps = new Map<
    AnyInfiniteQuery,
    Map<string, InfiniteClientEntry<unknown, unknown, unknown>>
  >()
  private readonly touchedQueries = new Set<AnyQuery>()
  private readonly touchedInfiniteQueries = new Set<AnyInfiniteQuery>()
  private readonly hydratedData = new Map<
    string,
    { data: unknown; lastUpdatedAt: number; origin: string | undefined }
  >()
  /**
   * The queries this root has used, by `id`. Plugins address queries by id,
   * and only a query this root has bound can have entries to address. Kept
   * per root, so a duplicate id is a collision within one app, not across the
   * process.
   */
  private readonly byId = new Map<string, AnyQuery | AnyInfiniteQuery>()
  private readonly refs = new Map<AnyQuery | AnyInfiniteQuery, QueryRef>()
  /** Mutations plugins started through `host.mutations.run`, per plugin and id. */
  private readonly pluginMutations = new Map<string, Mutation<unknown, unknown>>()
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
   * Root-wide query defaults from `queryEngine({ defaults })`. Read by
   * `ClientEntry` / `InfiniteClientEntry` / `createUse` / `createCache` when a
   * spec omits the field. Always an object (never `undefined`) so call sites
   * are a plain `spec.X ?? this.defaults.X ?? <built-in>`. Spec §5.9.
   */
  readonly defaults: QueryDefaults

  /** The root's plugins, or `null` when none are installed. */
  private readonly plugins: PluginSet | null

  constructor(opts?: {
    onError?: ErrorHandler
    hydrate?: DehydratedState
    devtools?: DevtoolsEmitter
    deps?: Record<string, unknown>
    defaults?: QueryDefaults
    plugins?: PluginSet | null
  }) {
    this.onError = opts?.onError
    this.devtools = opts?.devtools
    this.deps = opts?.deps ?? {}
    this.defaults = opts?.defaults ?? {}
    this.refetchOnWindowFocus = this.defaults.refetchOnWindowFocus ?? false
    this.refetchOnReconnect = this.defaults.refetchOnReconnect ?? false
    this.plugins = opts?.plugins ?? null
    if (opts?.hydrate) this.hydrate(opts.hydrate)
  }

  /** What plugins see of a query. One object per query, reused by every event. */
  refOf(query: AnyQuery | AnyInfiniteQuery): QueryRef {
    let ref = this.refs.get(query)
    if (ref === undefined) {
      ref = {
        id: query.__id,
        kind: query.__olas === 'infiniteQuery' ? 'infinite' : 'query',
        meta: query.__spec.meta ?? {},
      }
      this.refs.set(query, ref)
    }
    return ref
  }

  /** Record `query` under its id, so plugins can address it. */
  private index(query: AnyQuery | AnyInfiniteQuery): void {
    const existing = this.byId.get(query.__id)
    if (existing === query) return
    if (__DEV__ && existing !== undefined) {
      console.warn(
        `[olas] two different queries share the id '${query.__id}' in one root. Plugins, ` +
          'SSR payloads and devtools address queries by id, so the later one wins. Expected ' +
          'after a hot reload re-evaluates the module that defines it; a naming collision ' +
          'otherwise.',
      )
    }
    this.byId.set(query.__id, query)
  }

  private emitWrite(
    query: AnyQuery | AnyInfiniteQuery,
    key: readonly unknown[],
    data: unknown,
    updatedAt: number | undefined,
    source: WriteSource,
    origin: string | undefined,
  ): void {
    const plugins = this.plugins
    if (plugins === null || !plugins.listens('onWrite')) return
    plugins.emit('onWrite', {
      query: this.refOf(query),
      key,
      data,
      updatedAt: updatedAt ?? Date.now(),
      source,
      origin,
    })
  }

  private emitInvalidated(
    query: AnyQuery | AnyInfiniteQuery,
    key: readonly unknown[],
    origin: string | undefined,
  ): void {
    const plugins = this.plugins
    if (plugins === null || !plugins.listens('onInvalidate')) return
    plugins.emit('onInvalidate', { query: this.refOf(query), key, origin })
  }

  private emitRemoved(query: AnyQuery | AnyInfiniteQuery, key: readonly unknown[]): void {
    const plugins = this.plugins
    if (plugins === null || !plugins.listens('onRemove')) return
    plugins.emit('onRemove', { query: this.refOf(query), key, reason: 'gc' })
  }

  /** An entry's subscriber count crossed zero. Called by the entries. */
  emitActivity(query: AnyQuery | AnyInfiniteQuery, key: readonly unknown[], active: boolean): void {
    const plugins = this.plugins
    const hook = active ? 'onActivate' : 'onDeactivate'
    if (plugins === null || !plugins.listens(hook)) return
    plugins.emit(hook, { query: this.refOf(query), key })
  }

  /** Run one fetch attempt through the plugins' `wrapFetch` middleware. */
  runFetch(context: FetchContext, base: () => Promise<unknown>): Promise<unknown> {
    const plugins = this.plugins
    if (plugins === null || !plugins.hasFetchWrappers) return base()
    return plugins.wrapFetch(context, base)
  }

  /**
   * How a mutation reports to the plugins, or `undefined` when none observe
   * mutations — the runner then skips building events entirely.
   */
  mutationLifecycle(origin?: string): MutationLifecycleHooks | undefined {
    const plugins = this.plugins
    if (plugins === null || !plugins.observesMutations) return undefined
    return {
      emit: (event) => plugins.emit('onMutation', event),
      ...(plugins.hasMutateWrappers
        ? { wrap: (context, next) => plugins.wrapMutate(context, next) }
        : {}),
      ...(origin !== undefined ? { origin } : {}),
    }
  }

  /** The cache as plugin `origin` sees it (`PluginHost.queries`). */
  queryHost(origin: string): QueryHost {
    return {
      get: (id) => {
        const query = this.byId.get(id)
        return query === undefined ? undefined : this.refOf(query)
      },
      keys: (id) => {
        const query = this.byId.get(id)
        if (query === undefined) return []
        const map =
          query.__olas === 'infiniteQuery'
            ? this.infiniteMaps.get(query as AnyInfiniteQuery)
            : this.maps.get(query as AnyQuery)
        return map === undefined ? [] : [...map.values()].map((e) => e.keyArgs)
      },
      peek: (id, key) => {
        const found = this.entryByKey(id, key)
        if (found === undefined) return undefined
        return found.kind === 'query'
          ? found.entry.entry.data.peek()
          : found.entry.entry.pages.peek()
      },
      write: (id, key, updater) => this.writeByKey(id, key, updater, 'write', origin),
      replace: (id, key, value) => this.writeByKey(id, key, () => value, 'replace', origin),
      invalidate: (id, key) => {
        const found = this.entryByKey(id, key)
        if (found === undefined) return Promise.resolve()
        const settled = this.invalidateEntry(found.entry)
        this.emitInvalidated(found.entry.query, found.entry.keyArgs, origin)
        return settled
      },
      hydrate: (state) => {
        if (!this.acceptsState(state)) return
        for (const e of state.entries) {
          this.applyDehydratedEntry(e.id, e.key, e.data, e.lastUpdatedAt, origin)
        }
      },
      dehydrate: () => this.dehydrate(),
      hashKey: (key) => stableHash(key),
    }
  }

  /** Registered mutations, runnable by plugin `origin` (`PluginHost.mutations`). */
  mutationHost(origin: string): MutationHost {
    return {
      has: (id) => lookupRegisteredMutation(id) !== undefined,
      run: (id, variables) => this.runRegistered(id, variables, origin),
    }
  }

  private runRegistered(id: string, variables: unknown, origin: string): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('[olas] host.mutations.run() after the root was disposed'))
    }
    const registered = lookupRegisteredMutation(id)
    if (registered === undefined) {
      return Promise.reject(
        new Error(
          `[olas] host.mutations.run('${id}'): no mutation is registered under that id. Import ` +
            `the module that calls defineMutation({ id: '${id}' }) before running it.`,
        ),
      )
    }
    // One runner per plugin and id, so a definition's `serial` / `latest-wins`
    // concurrency holds across that plugin's runs of it.
    const slot = `${origin}\u0000${id}`
    let mutation = this.pluginMutations.get(slot)
    if (mutation === undefined) {
      mutation = createMutationImpl<unknown, unknown>(
        registered.definition as unknown as MutationSpec<unknown, unknown>,
        this.onError,
        ['plugin', origin],
        this.mutationsInflight$,
        this.devtools,
        this.mutationLifecycle(origin),
        this.deps as import('../controller/types').AmbientDeps,
      )
      this.pluginMutations.set(slot, mutation)
    }
    return (mutation.run as (v: unknown) => Promise<unknown>)(variables)
  }

  private entryByKey(
    id: string,
    key: readonly unknown[],
  ):
    | { kind: 'query'; entry: ClientEntry<unknown> }
    | { kind: 'infinite'; entry: InfiniteClientEntry<unknown, unknown, unknown> }
    | undefined {
    const query = this.byId.get(id)
    if (query === undefined) return undefined
    const hash = stableHash(key)
    if (query.__olas === 'infiniteQuery') {
      const entry = this.infiniteMaps.get(query as AnyInfiniteQuery)?.get(hash)
      return entry === undefined ? undefined : { kind: 'infinite', entry }
    }
    const entry = this.maps.get(query as AnyQuery)?.get(hash)
    return entry === undefined ? undefined : { kind: 'query', entry }
  }

  /** A plugin's canonical write to an existing entry (`write` / `replace`). */
  private writeByKey(
    id: string,
    key: readonly unknown[],
    updater: (prev: unknown) => unknown,
    source: 'write' | 'replace',
    origin: string,
  ): void {
    const found = this.entryByKey(id, key)
    if (found === undefined) return
    if (found.kind === 'query') {
      const { entry } = found
      entry.entry.setData(updater as (prev: unknown) => never, { track: false })
      const data = entry.entry.data.peek()
      if (source === 'replace' && data !== undefined) entry.entry.cancel()
      this.emitWrite(
        entry.query,
        entry.keyArgs,
        data,
        entry.entry.lastUpdatedAt.peek(),
        source,
        origin,
      )
      if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, source)
      return
    }
    const { entry } = found
    entry.entry.setData(updater as (prev: unknown[] | undefined) => unknown[], { track: false })
    const pages = entry.entry.pages.peek()
    if (source === 'replace') entry.entry.cancel()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      pages,
      entry.entry.lastUpdatedAt.peek(),
      source,
      origin,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, pages, source)
  }

  private acceptsState(state: DehydratedState): boolean {
    if (state.version === 1) return true
    // A silent drop would hide a schema-bumped payload. Warn so a future
    // format bump is detectable from the client side.
    if (__DEV__) {
      console.warn(
        '[olas] hydrate(): unsupported state.version =',
        state.version,
        '— expected 1. Dropping payload; cache will fetch fresh.',
      )
    }
    return false
  }

  /**
   * Emit a devtools `cache:set-data` event for a cache write. Same `source`
   * vocabulary as the plugins' `WriteEvent`. A write inside a mutation's
   * `onMutate` or rollback inherits the run's `causeId` from the ambient
   * cause. Call sites guard with `if (__DEV__)` so production strips them.
   */
  private emitDevtoolsSetData(
    query: AnyQuery | AnyInfiniteQuery,
    queryKey: readonly unknown[],
    data: unknown,
    source: WriteSource,
  ): void {
    if (this.devtools === undefined) return
    this.devtools.emit({
      type: 'cache:set-data',
      queryId: query.__id,
      queryKey,
      source,
      data,
      causeId: __currentCauseId(),
    })
  }

  /**
   * Apply a single dehydrated entry to the cache. Idempotent across
   * pre-bind / post-bind:
   *
   * - If the matching `ClientEntry` already exists (a subscriber has
   *   bound this key), `Entry.applyHydration(data, lastUpdatedAt)` writes
   *   through with the server's timestamp + supersedes any inflight
   *   fetch. Plugins see one `WriteEvent` with `source: 'hydrate'`.
   * - If no `ClientEntry` exists yet (the subscribing component hasn't
   *   mounted), the entry is buffered in `hydratedData` so the next
   *   `bindEntry` for that hash picks it up — same path the constructor
   *   `hydrate(state)` uses.
   *
   * Designed for streaming SSR: each `<Suspense>` boundary that resolves
   * on the server pushes its dehydrated entry through this method on the
   * client as the bootstrap script executes.
   */
  applyDehydratedEntry(
    queryId: string,
    keyArgs: readonly unknown[],
    data: unknown,
    lastUpdatedAt: number,
    origin?: string,
  ): void {
    const hash = stableHash(keyArgs)
    const query = this.byId.get(queryId)
    if (query !== undefined && query.__olas === 'query') {
      const entry = this.maps.get(query as AnyQuery)?.get(hash)
      if (entry !== undefined) {
        entry.entry.applyHydration(data, lastUpdatedAt)
        this.emitWrite(entry.query, entry.keyArgs, data, lastUpdatedAt, 'hydrate', origin)
        if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'hydrate')
        return
      }
    }
    // No local entry yet — buffer in the same map the constructor uses.
    // The next bindEntry for this query + key will adopt the buffered payload
    // and clear the slot. Namespaced by queryId so a colliding-key query can't
    // steal it (spec §15, T1.2).
    this.hydratedData.set(hydrationKey(queryId, hash), { data, lastUpdatedAt, origin })
  }

  /** Buffer a payload for entries not bound yet (`RootOptions.hydrate`). */
  hydrate(state: DehydratedState): void {
    if (!this.acceptsState(state)) return
    for (const entry of state.entries) {
      const hash = stableHash(entry.key)
      this.hydratedData.set(hydrationKey(entry.id, hash), {
        data: entry.data,
        lastUpdatedAt: entry.lastUpdatedAt,
        origin: undefined,
      })
    }
  }

  /**
   * Snapshot every live cache entry (regular + infinite) as a flat list of
   * `DebugCacheEntry`. Exposed via `root.debug.queryEntries()` for the
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
    for (const [query, map] of this.maps) {
      for (const ce of map.values()) {
        if (ce.entry.status.peek() === 'success') {
          entries.push({
            id: query.__id,
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
    // The 100-iteration safety bound exists so a pathological setup that
    // keeps starting new fetches doesn't lock the dehydrate path. This is
    // a correctness failure for SSR: silently returning would let
    // `dehydrate()` ship an incomplete payload that looks clean. Throw so
    // the SSR boundary surfaces it instead of pretending success.
    const unsettled: Array<{ key: readonly unknown[]; kind: 'data' | 'infinite' }> = []
    for (const map of this.maps.values()) {
      for (const ce of map.values()) {
        if (ce.entry.isFetching.peek()) unsettled.push({ key: ce.keyArgs, kind: 'data' })
      }
    }
    for (const map of this.infiniteMaps.values()) {
      for (const ce of map.values()) {
        if (ce.entry.isFetching.peek()) unsettled.push({ key: ce.keyArgs, kind: 'infinite' })
      }
    }
    const err = new Error(
      '[olas] waitForIdle: exceeded 100-iteration safety bound — cache or mutations keep restarting',
    ) as Error & { unsettled: typeof unsettled; mutationsInflight: number }
    err.unsettled = unsettled
    err.mutationsInflight = this.mutationsInflight$.peek()
    throw err
  }

  bindQuery<Args extends unknown[], T>(
    query: Query<Args, T>,
    options?: BindQueryOptions,
  ): QueryActions<Args, T>
  bindQuery<Args extends unknown[], TPage, TItem>(
    query: InfiniteQuery<Args, TPage, TItem>,
    options?: BindQueryOptions,
  ): InfiniteQueryActions<Args, TPage, TItem>
  bindQuery(
    source: Query<any, any> | InfiniteQuery<any, any, any>,
    options?: BindQueryOptions,
  ): QueryActions<any, any> | InfiniteQueryActions<any, any, any> {
    const query = source as AnyQuery | AnyInfiniteQuery
    const getClient = () => {
      if (this.disposed) throw new Error('[olas] Bound query operation called after root disposal')
      return this
    }
    getClient()
    query.__clients.add(this)
    this.index(query)
    const origin = options?.origin
    if (query.__olas === 'infiniteQuery') {
      this.touchedInfiniteQueries.add(query)
      return createInfiniteQueryActions(query, getClient, origin)
    }
    this.touchedQueries.add(query)
    return createQueryActions(query, getClient, origin)
  }

  bindEntry<Args extends unknown[], T>(query: Query<Args, T>, args: Args): ClientEntry<T> {
    const internal = query as AnyQuery
    let map = this.maps.get(internal)
    if (!map) {
      map = new Map()
      this.maps.set(internal, map)
      this.touchedQueries.add(internal)
      internal.__clients.add(this)
      this.index(internal)
    }
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    let entry = map.get(hash) as ClientEntry<T> | undefined
    if (!entry) {
      const hkey = hydrationKey(internal.__id, hash)
      const hydrated = this.hydratedData.get(hkey) as
        | { data: T; lastUpdatedAt: number; origin: string | undefined }
        | undefined
      if (hydrated) this.hydratedData.delete(hkey)
      // The entry reports its own successful fetches through this closure, so
      // the emitters can stay private to the client.
      const onFetched = (data: T): void =>
        this.emitWrite(
          internal,
          keyArgs,
          data,
          created.entry.lastUpdatedAt.peek(),
          'fetch',
          undefined,
        )
      const created: ClientEntry<T> = new ClientEntry<T>(
        this,
        internal,
        args,
        keyArgs,
        internal.__spec,
        hydrated,
        onFetched,
      )
      entry = created
      map.set(hash, entry as ClientEntry<unknown>)
      // The entry is created without an immediate subscriber (callers like
      // `prefetch`/`setData`/`invalidate` reach `bindEntry` first; subscribing
      // callers then call `acquire()` right after, which clears the gc timer).
      entry.scheduleGcIfOrphan()
      // Buffered hydrated data lands in `initialData` on the new Entry, so no
      // fetch ever reports it. Report it here, once, as the `'hydrate'` write
      // it is — plugins observing every write (entities) would otherwise miss
      // every hydrated row.
      if (hydrated !== undefined) {
        this.emitWrite(
          internal,
          keyArgs,
          hydrated.data,
          hydrated.lastUpdatedAt,
          'hydrate',
          hydrated.origin,
        )
        if (__DEV__) this.emitDevtoolsSetData(internal, keyArgs, hydrated.data, 'hydrate')
      }
    } else if (__DEV__) {
      // The fetcher closure is captured on first `bindEntry`. If a later
      // subscriber binds the SAME `keyArgs` (same hash) but DIFFERENT
      // `callArgs`, the next refetch will still use the first caller's
      // arguments — a silent staleness footgun when a `key()` function
      // collapses non-key args (e.g. headers, abort tokens). Warn so the
      // mismatch is surfaced; the consumer should either include the diff
      // in the key or accept the documented "first wins" behavior.
      const prev = entry.callArgs
      const len = Math.max(prev.length, args.length)
      let mismatch = prev.length !== args.length
      for (let i = 0; i < len && !mismatch; i++) {
        if (!Object.is(prev[i], args[i])) mismatch = true
      }
      if (mismatch) {
        // eslint-disable-next-line no-console
        console.warn(
          `[olas] bindEntry: hash collision with diverging callArgs for query` +
            ` ${internal.__spec.id} key=${JSON.stringify(keyArgs)}.` +
            ` First bind's args are used by the fetcher; later args ignored.` +
            ` Either include the difference in spec.key(...) or pass identical args.`,
        )
      }
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
      this.devtools?.emit({ type: 'cache:gc', queryId: entry.query.__id, queryKey: entry.keyArgs })
    }
    this.emitRemoved(entry.query, entry.keyArgs)
  }

  /**
   * Invalidate one entry: if it has subscribers, mark stale AND refetch; if
   * not, mark stale only — the next subscriber refetches. Spec §5.7 says
   * invalidate refetches only IF subscribed; the old always-fetch behavior woke
   * orphaned entries that no one was watching (T3.9). Works for both
   * `ClientEntry` and `InfiniteClientEntry`.
   */
  private invalidateEntry(entry: {
    hasSubscribers(): boolean
    keyArgs: readonly unknown[]
    query: { readonly __id: string }
    entry: { invalidate(): Promise<unknown>; markStale(): void }
  }): Promise<void> {
    if (entry.hasSubscribers()) {
      // Resolve when the triggered refetch settles. Errors are reported through
      // `onError` (as before) and swallowed for the awaiter, so `await invalidate()`
      // never throws — it means "the refetch this invalidate kicked off has finished",
      // matching TanStack's `invalidateQueries`.
      return entry.entry.invalidate().then(
        () => {},
        (err) => {
          if (isAbortError(err)) return
          dispatchError(this.onError, err, {
            kind: 'cache',
            controllerPath: [],
            queryId: entry.query.__id,
            key: entry.keyArgs,
          })
        },
      )
    }
    // Subscriber-less: marked stale only, no refetch, so nothing to await.
    entry.entry.markStale()
    return Promise.resolve()
  }

  invalidate<Args extends unknown[]>(
    query: Query<Args, any>,
    args: Args,
    origin?: string,
  ): Promise<void> {
    const internal = query as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return Promise.resolve()
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    const entry = map.get(hash)
    if (!entry) return Promise.resolve()
    if (__DEV__) {
      this.devtools?.emit({ type: 'cache:invalidated', queryId: internal.__id, queryKey: keyArgs })
    }
    const settled = this.invalidateEntry(entry)
    this.emitInvalidated(internal, keyArgs, origin)
    return settled
  }

  invalidateAll(query: Query<any, any>, origin?: string): Promise<void> {
    const internal = query as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return Promise.resolve()
    const settled: Promise<void>[] = []
    for (const entry of map.values()) {
      if (__DEV__) {
        this.devtools?.emit({
          type: 'cache:invalidated',
          queryId: internal.__id,
          queryKey: entry.keyArgs,
        })
      }
      settled.push(this.invalidateEntry(entry))
      this.emitInvalidated(internal, entry.keyArgs, origin)
    }
    return Promise.all(settled).then(() => {})
  }

  cancel<Args extends unknown[]>(query: Query<Args, any>, args: Args): void {
    const internal = query as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return
    const hash = stableHash(internal.__spec.key(...args))
    map.get(hash)?.entry.cancel()
  }

  cancelAll(query: Query<any, any>): void {
    const map = this.maps.get(query as AnyQuery)
    if (!map) return
    for (const entry of map.values()) entry.entry.cancel()
  }

  /**
   * Synchronous, non-creating, non-subscribing read of one keyed entry's data
   * (spec §5.5). The counterpart to `setData` / `cancel`, which could already
   * reach a keyed entry imperatively while nothing could *read* one.
   *
   * Deliberately does NOT call `bindEntry`: a peek must not mint an entry, or
   * "is anything cached for this key?" would answer itself yes. `undefined`
   * therefore covers both "no entry" (never fetched, or gc'd) and "entry has
   * not settled". A caller that needs to distinguish those has `status` through
   * a subscription; a caller that only wants to guard a merge (patch if we
   * have data, skip if we don't) wants exactly this.
   *
   * `.peek()` on the signal, so calling this inside a `computed` or an effect
   * registers no dependency — a peek is not a subscription and must not
   * silently behave like one.
   */
  peekData<Args extends unknown[], T>(query: Query<Args, T>, args: Args): T | undefined {
    const internal = query as AnyQuery
    const map = this.maps.get(internal)
    if (!map) return undefined
    const hash = stableHash(internal.__spec.key(...args))
    return map.get(hash)?.entry.data.peek() as T | undefined
  }

  /**
   * A **canonical** write to one keyed entry: patches data, pushes no
   * optimistic snapshot, never flips `hasPendingMutations` (spec §6.4).
   *
   * The userland counterpart to the plugin-facing `host.queries.write` — same
   * `{ track: false }` path through `Entry.setData`, same `source: 'write'`
   * event, so cross-tab and entity plugins see it exactly as they see any
   * other canonical write. What it is NOT is an optimistic patch: there is no
   * `Snapshot` to roll back, which is the whole point. `setData`'s snapshot
   * exists to be settled by the mutation that created it, and a fire-and-forget
   * patcher (a server-push handler, a realtime event fold) has no mutation to
   * settle it — so with `setData` every call leaves a live snapshot record on
   * the entry forever: `hasPendingMutations` wedged at `true` and an array that
   * grows without bound on a long-lived entry.
   *
   * Unlike `host.queries.write` this DOES bind (create) the entry when absent, for
   * one reason: symmetry with `setData`, whose behaviour it otherwise matches
   * exactly. Guard with `peekData` when writing into a possibly-absent key is
   * wrong for your data shape (a merge over `undefined` usually is).
   */
  writeData<Args extends unknown[], T>(
    query: Query<Args, T>,
    args: Args,
    updater: (prev: T | undefined) => T,
    origin?: string,
  ): void {
    const entry = this.bindEntry(query, args)
    // A PATCH, and so it leaves a fetch that is already in flight alone (§5.5, §6.4). That is
    // deliberate: an updater reading `prev` describes the fields it touches and says nothing
    // about the others, so a response already on its way may well be carrying newer values for
    // them. Discarding it on the strength of a one-field patch loses those. `replaceData` is the
    // write that supersedes, and it takes a whole value precisely so the caller cannot make that
    // claim by accident. A caller who has decided this patch should win calls `cancel(...)`
    // first. 0.7.0 and 0.7.1 had `write` supersede and were rolled back over exactly this.
    //
    // `setData` differs again, one step further down: an optimistic patch is a guess, and a
    // server response is entitled to overrule a guess, so it does not even rebase live snapshots
    // onto itself the way this does. Those two asymmetries are the whole reason the three methods
    // are separate (`.wiki/decisions/canonical-vs-optimistic-writes.md`), and they are where this
    // diverges from react-query, which has one door for all three and therefore cannot treat them
    // differently.
    entry.entry.setData(updater, { track: false })
    const data = entry.entry.data.peek()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      data,
      entry.entry.lastUpdatedAt.peek(),
      'write',
      origin,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'write')
  }

  /**
   * Replace one keyed entry's data with a value that IS the record — and supersede any fetch
   * already in flight for it (spec §6.4).
   *
   * The difference from `writeData` is the claim being made, and the signature is what makes it
   * honest: a whole value rather than an updater. A patch built from `prev` describes the fields
   * it touches and nothing else, so a response already on its way may be carrying newer values
   * for the rest; discarding it would lose them. A replacement asserts there is nothing else —
   * this is the record now — which is exactly the precondition under which an older request has
   * nothing left to contribute. The canonical source is a server read-back taken after the write
   * it reports.
   *
   * Supersedes only when `value` is defined, for the reason `Entry.setData` makes necessary: it
   * flips an idle/pending entry to `success` whatever it is handed, so replacing with `undefined`
   * AND cancelling would strand the entry at `success` over no data, with nothing to refetch it
   * until `staleTime` lapses. `Entry.cancel` is a no-op when nothing is fetching.
   */
  replaceData<Args extends unknown[], T>(
    query: Query<Args, T>,
    args: Args,
    value: T,
    origin?: string,
  ): void {
    const entry = this.bindEntry(query, args)
    entry.entry.setData(() => value, { track: false })
    if (value !== undefined) entry.entry.cancel()
    const data = entry.entry.data.peek()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      data,
      entry.entry.lastUpdatedAt.peek(),
      'replace',
      origin,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'replace')
  }

  setData<Args extends unknown[], T>(
    query: Query<Args, T>,
    args: Args,
    updater: (prev: T | undefined) => T,
    origin?: string,
  ): Snapshot {
    const entry = this.bindEntry(query, args)
    const snapshot = entry.entry.setData(updater)
    // Report the post-update value — plugins want the new state, not the
    // updater function (which would be uncloneable across BroadcastChannel).
    const data = entry.entry.data.peek()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      data,
      entry.entry.lastUpdatedAt.peek(),
      'optimistic',
      origin,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'optimistic')
    // Report the rollback too, so plugins that mirrored the optimistic value
    // (cross-tab, entities) drop it (T3.6). Only when data actually changed:
    // a non-top chain-splice rollback (§6.4) leaves current data untouched.
    return {
      rollback: () => {
        const before = entry.entry.data.peek()
        snapshot.rollback()
        const after = entry.entry.data.peek()
        if (!Object.is(before, after)) {
          this.emitWrite(
            entry.query,
            entry.keyArgs,
            after,
            entry.entry.lastUpdatedAt.peek(),
            'rollback',
            origin,
          )
          if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, after, 'rollback')
        }
      },
      finalize: () => snapshot.finalize(),
    }
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
      this.index(internal)
    }
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    let entry = map.get(hash) as InfiniteClientEntry<TPage, TItem, unknown> | undefined
    if (!entry) {
      // Every successful page batch (initial, next, prev) reports through this
      // closure, as in `bindEntry`.
      const onFetched = (pages: TPage[]): void =>
        this.emitWrite(
          internal,
          keyArgs,
          pages,
          created.entry.lastUpdatedAt.peek(),
          'fetch',
          undefined,
        )
      const created: InfiniteClientEntry<TPage, TItem, unknown> = new InfiniteClientEntry<
        TPage,
        TItem,
        unknown
      >(this, internal, args, keyArgs, internal.__spec, onFetched)
      entry = created
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
    if (__DEV__) {
      this.devtools?.emit({ type: 'cache:gc', queryId: entry.query.__id, queryKey: entry.keyArgs })
    }
    this.emitRemoved(entry.query, entry.keyArgs)
  }

  invalidateInfinite<Args extends unknown[]>(
    query: InfiniteQuery<Args, any, any>,
    args: Args,
    origin?: string,
  ): Promise<void> {
    const internal = query as AnyInfiniteQuery
    const map = this.infiniteMaps.get(internal)
    if (!map) return Promise.resolve()
    const keyArgs = internal.__spec.key(...args)
    const hash = stableHash(keyArgs)
    const entry = map.get(hash)
    if (!entry) return Promise.resolve()
    if (__DEV__) {
      this.devtools?.emit({ type: 'cache:invalidated', queryId: internal.__id, queryKey: keyArgs })
    }
    const settled = this.invalidateEntry(entry)
    this.emitInvalidated(internal, keyArgs, origin)
    return settled
  }

  invalidateAllInfinite(query: InfiniteQuery<any, any, any>, origin?: string): Promise<void> {
    const internal = query as AnyInfiniteQuery
    const map = this.infiniteMaps.get(internal)
    if (!map) return Promise.resolve()
    const settled: Promise<void>[] = []
    for (const entry of map.values()) {
      if (__DEV__) {
        this.devtools?.emit({
          type: 'cache:invalidated',
          queryId: internal.__id,
          queryKey: entry.keyArgs,
        })
      }
      settled.push(this.invalidateEntry(entry))
      this.emitInvalidated(internal, entry.keyArgs, origin)
    }
    return Promise.all(settled).then(() => {})
  }

  cancelInfinite<Args extends unknown[]>(query: InfiniteQuery<Args, any, any>, args: Args): void {
    const internal = query as AnyInfiniteQuery
    const map = this.infiniteMaps.get(internal)
    if (!map) return
    const hash = stableHash(internal.__spec.key(...args))
    map.get(hash)?.entry.cancel()
  }

  cancelAllInfinite(query: InfiniteQuery<any, any, any>): void {
    const map = this.infiniteMaps.get(query as AnyInfiniteQuery)
    if (!map) return
    for (const entry of map.values()) entry.entry.cancel()
  }

  setInfiniteData<Args extends unknown[], TPage>(
    query: InfiniteQuery<Args, TPage, any>,
    args: Args,
    updater: (prev: TPage[] | undefined) => TPage[],
    origin?: string,
  ): Snapshot {
    const entry = this.bindInfiniteEntry(query, args)
    const snapshot = entry.entry.setData(updater)
    const pages = entry.entry.pages.peek()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      pages,
      entry.entry.lastUpdatedAt.peek(),
      'optimistic',
      origin,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, pages, 'optimistic')
    // Report the rollback so plugins mirroring the optimistic pages drop them
    // (T3.6); only on an actual change (a non-top chain-splice is a no-op).
    return {
      rollback: () => {
        const before = entry.entry.pages.peek()
        snapshot.rollback()
        const after = entry.entry.pages.peek()
        if (!Object.is(before, after)) {
          this.emitWrite(
            entry.query,
            entry.keyArgs,
            after,
            entry.entry.lastUpdatedAt.peek(),
            'rollback',
            origin,
          )
          if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, after, 'rollback')
        }
      },
      finalize: () => snapshot.finalize(),
    }
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
      return entry.entry.startFetch().catch((err) => {
        // A supersede aborts this fetch without it being a failure — a newer refetch, a key
        // change, or a canonical `write` landing while this was outstanding (§6.4). Don't
        // surface the spurious AbortError: resolve with whatever the entry settles on, which
        // is what `subscription.refetch` has done since T3.9 (`use.ts`) and what an awaiting
        // SSR loader needs. Real errors still reject.
        if (isAbortError(err)) return entry.entry.firstValue()
        throw err
      })
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
    for (const mutation of this.pluginMutations.values()) mutation.dispose()
    this.pluginMutations.clear()
    this.byId.clear()
    this.refs.clear()
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
