import { BRAND } from '../brand'
import { __currentCauseId, type DevtoolsEmitter } from '../devtools'
import { dispatchError, type ErrorHandler } from '../errors'
import { scheduleExpiry } from '../expiry-timer'
import type { PluginEngine, PluginSet } from '../plugin/host'
import type {
  FetchContext,
  MutationHost,
  QueryHost,
  QueryRef,
  WriteEvent,
  WriteSource,
} from '../plugin/types'
import { type Signal, signal } from '../signals'
import { isAbortError } from '../utils'
import { createInfiniteQueryActions, createQueryActions } from './actions'
import { Entry, type EntryEvents, notInFuture } from './entry'
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
  DehydratedEntry,
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

/** An entry, as `emitWrite` reads its server truth. */
type ServerSource =
  | Pick<Entry<unknown>, 'serverState'>
  | Pick<InfiniteEntry<unknown, unknown, unknown>, 'serverState'>

/**
 * A write event's `server` (§13.1): what `dehydrate()` would ship for the
 * entry, the data beneath any live optimistic write. `undefined` when the
 * entry holds neither data nor a server answer.
 */
function serverOf(from: ServerSource): WriteEvent['server'] {
  const row = from.serverState()
  if (row === null) return undefined
  return 'pages' in row
    ? { data: row.pages, updatedAt: row.updatedAt, pageParams: row.pageParams }
    : { data: row.data, updatedAt: row.updatedAt }
}

/**
 * Whether two binds passed the same call arg, for the dev warning in
 * `bindEntry`. Plain objects and arrays compare structurally, so equal args
 * built afresh on every re-key match, and a `Date` compares by its time. There
 * is no JSON normalization, unlike the key hash (§5.4): `Infinity` and
 * `-Infinity`, or a `Date` and its ISO string, share an entry and differ here,
 * so the fetcher dropping one of them warns. `NaN` matches `NaN`, and `-0`
 * matches `0`. Anything else, such as a function or a class instance, compares
 * by identity. A cycle compares without recursing forever, and a structure too
 * deep to walk counts as different.
 */
function sameCallArg(a: unknown, b: unknown): boolean {
  try {
    return equalCallArgs(a, b, new Map())
  } catch {
    return false
  }
}

function equalCallArgs(a: unknown, b: unknown, seen: Map<object, object>): boolean {
  // SameValueZero: `NaN` equals itself, and `-0` equals `0`.
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && equalCallArgs(a.getTime(), b.getTime(), seen)
  }
  const proto: unknown = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b)) return false
  const isArray = Array.isArray(a)
  if (!isArray && proto !== Object.prototype && proto !== null) return false
  // A pair already under comparison counts as equal, so a cycle ends here.
  if (seen.get(a) === b) return true
  seen.set(a, b)
  if (isArray) {
    const as = a as unknown[]
    const bs = b as unknown[]
    if (as.length !== bs.length) return false
    for (let i = 0; i < as.length; i++) {
      if (!equalCallArgs(as[i], bs[i], seen)) return false
    }
    return true
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  for (const k of keys) {
    if (!Object.hasOwn(rb, k)) return false
    if (!equalCallArgs(ra[k], rb[k], seen)) return false
  }
  return true
}

/**
 * A key as a warning prints it: JSON, with a bigint written as `1n`. Plain
 * `JSON.stringify` throws on a bigint, and the warning must not break the bind.
 */
function describeKey(key: readonly unknown[]): string {
  try {
    return JSON.stringify(key, (_name, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
    )
  } catch {
    return String(key)
  }
}

/** The shape a dehydrated entry must have before hydration reads it. */
function isHydrationEntry(value: unknown): value is DehydratedEntry {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    Array.isArray(e.key) &&
    typeof e.lastUpdatedAt === 'number' &&
    (e.pageParams === undefined || Array.isArray(e.pageParams))
  )
}

/**
 * An infinite entry's hydration payload, when `data` is a pages array with a
 * `pageParams` array of the same length. Anything else cannot seed pages.
 */
function infinitePayload(
  data: unknown,
  pageParams: readonly unknown[] | undefined,
): { pages: unknown[]; pageParams: unknown[] } | undefined {
  if (!Array.isArray(data) || !Array.isArray(pageParams)) return undefined
  if (data.length === 0 || data.length !== pageParams.length) return undefined
  return { pages: data, pageParams: [...pageParams] }
}

/** A buffered hydration payload, waiting for its entry to be bound. */
type HydratedSlot = {
  data: unknown
  lastUpdatedAt: number
  origin: string | undefined
  /**
   * Present for an infinite query's payload; `data` is then its pages.
   */
  pageParams: readonly unknown[] | undefined
}

/**
 * The devtools event bundle an entry reports through, regular or infinite:
 * fetch start and settle (with the write it produced, correlated by
 * `causeId`), and the optimistic snapshot layer events.
 */
function devtoolsEntryEvents(
  devtools: DevtoolsEmitter | undefined,
  queryId: string,
  queryKey: readonly unknown[],
): EntryEvents | undefined {
  if (devtools === undefined) return undefined
  return {
    onFetchStart: (fetchId) =>
      devtools.emit({ type: 'cache:fetch-start', queryId, queryKey, causeId: fetchId }),
    onFetchSuccess: (durationMs, data, fetchId) => {
      devtools.emit({
        type: 'cache:fetch-success',
        queryId,
        queryKey,
        durationMs,
        causeId: fetchId,
      })
      // The data write the fetch produced — correlated with the fetch via
      // `causeId` so the timeline groups them and the cache inspector updates
      // without polling.
      devtools.emit({
        type: 'cache:set-data',
        queryId,
        queryKey,
        source: 'fetch',
        data,
        causeId: fetchId,
      })
    },
    onFetchError: (durationMs, error, fetchId) =>
      devtools.emit({
        type: 'cache:fetch-error',
        queryId,
        queryKey,
        durationMs,
        error,
        causeId: fetchId,
      }),
    // `causeId` is read from the ambient cause (the mutation run whose
    // `onMutate`/rollback is executing) at emit time — see `__runWithCause`.
    onSnapshotPush: () =>
      devtools.emit({ type: 'snapshot:push', queryKey, causeId: __currentCauseId() }),
    onSnapshotRollback: () =>
      devtools.emit({ type: 'snapshot:rollback', queryKey, causeId: __currentCauseId() }),
    onSnapshotFinalize: () =>
      devtools.emit({ type: 'snapshot:finalize', queryKey, causeId: __currentCauseId() }),
  }
}

/**
 * Tell the devtools a subscription bound (`joined`) or left an entry, with the
 * subscribing controller's path. A no-op without a bus. Call sites guard it
 * with `if (__DEV__)`, so production builds drop the call.
 */
function reportSubscriber(
  devtools: DevtoolsEmitter | undefined,
  query: { readonly __id: string },
  queryKey: readonly unknown[],
  subscriberPath: readonly string[],
  joined: boolean,
): void {
  devtools?.emit({
    type: joined ? 'cache:subscribed' : 'cache:unsubscribed',
    queryId: query.__id,
    queryKey,
    subscriberPath,
  })
}

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
  /** Every hold on the entry: subscriptions and in-flight prefetches. Drives gc. */
  private subscriberCount = 0
  /** The holds that are controller subscriptions — what the devtools count. */
  private subscriptions = 0
  /** Set by `dispose`. A late `release()` (a prefetch settling after the root
   *  went away) must not arm a gc timer for a dead entry. */
  private disposed = false
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
    const queryId = query.__id
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
      events: __DEV__ ? devtoolsEntryEvents(devtools, queryId, queryKey) : undefined,
      onSuccessData: onFetched,
      hasSubscribers: () => this.hasSubscribers(),
    })
  }

  /**
   * Hold the entry. `subscriberPath` is the subscribing controller's path; it
   * is absent for a hold that is not a subscription, such as a prefetch.
   */
  acquire(subscriberPath?: readonly string[]): void {
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
    if (subscriberPath !== undefined) {
      this.subscriptions += 1
      if (__DEV__)
        reportSubscriber(this.client.devtools, this.query, this.keyArgs, subscriberPath, true)
    }
  }

  /** Let go of a hold `acquire` took, with the same `subscriberPath`. */
  release(subscriberPath?: readonly string[]): void {
    if (this.disposed) return
    this.subscriberCount -= 1
    if (subscriberPath !== undefined) {
      this.subscriptions -= 1
      if (__DEV__)
        reportSubscriber(this.client.devtools, this.query, this.keyArgs, subscriberPath, false)
    }
    if (this.subscriberCount <= 0) {
      if (this.subscriberCount === 0) this.client.emitActivity(this.query, this.keyArgs, false)
      this.stopIntervalTimer()
      this.stopEventSubscriptions()
      // The root is tearing down, and the client disposes every entry next: a
      // gc timer armed now would only be cancelled.
      if (this.client.isClosing) return
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

  /** Controller subscriptions holding the entry, for `root.debug.queryEntries()`. */
  get subscriptionCount(): number {
    return this.subscriptions
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
      // A fetch parked for the network runs once the network is back, and the
      // tick starts nothing else: offline, each tick would park one more
      // waiter. Without this, a park the `online` event missed stayed for good.
      if (this.entry.isPaused.peek()) {
        this.entry.resumeParked()
        return
      }
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
    // Join an in-flight fetch instead of aborting + restarting it — a focus /
    // reconnect landing mid-fetch shouldn't cancel it (T3.9, cf. T3.2 interval).
    if (this.entry.isFetching.peek()) return
    // A parked fetch runs through the entry's drain, and only once online: on
    // one `online` event, starting a fetch here as well as the drain made a
    // request and then aborted it for another.
    if (this.entry.isPaused.peek()) {
      this.entry.resumeParked()
      return
    }
    if (!this.entry.isStaleNow()) return
    this.entry.startFetch().catch(() => {
      /* error already captured on entry */
    })
  }

  dispose(): void {
    this.disposed = true
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
  /** See `ClientEntry.subscriberCount`. */
  private subscriberCount = 0
  /** See `ClientEntry.subscriptions`. */
  private subscriptions = 0
  /** Set by `dispose`. A late `release()` (a prefetch settling after the root
   *  went away) must not arm a gc timer for a dead entry. */
  private disposed = false
  /** Cancellation closure from `scheduleExpiry`; `null` = no gc pending. */
  private gcTimer: (() => void) | null = null
  /** Cancellation closure from `scheduleExpiry`; `null` = chain stopped. */
  private intervalTimer: (() => void) | null = null
  private gcTime: number
  /** See `ClientEntry.nextIntervalMs` — same closure, same variance reason. */
  private nextIntervalMs: (() => number | null) | undefined
  private unsubFocus: (() => void) | null = null
  private unsubOnline: (() => void) | null = null
  private readonly refetchOnWindowFocus: boolean
  private readonly refetchOnReconnect: boolean

  constructor(
    client: QueryClient,
    query: AnyInfiniteQuery,
    callArgs: readonly unknown[],
    keyArgs: readonly unknown[],
    spec: InfiniteQuerySpec<any, PageParam, TPage, TItem>,
    hydrated: { pages: TPage[]; pageParams: PageParam[]; lastUpdatedAt: number } | undefined,
    /** Reports every successful page batch as a `'fetch'` write. See `ClientEntry`. */
    onFetched: (pages: TPage[]) => void,
  ) {
    this.client = client
    this.query = query
    this.callArgs = callArgs
    this.keyArgs = keyArgs
    this.refetchOnWindowFocus = spec.refetchOnWindowFocus ?? client.refetchOnWindowFocus
    this.refetchOnReconnect = spec.refetchOnReconnect ?? client.refetchOnReconnect
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
      initialPages: hydrated?.pages,
      initialPageParams: hydrated?.pageParams,
      initialUpdatedAt: hydrated?.lastUpdatedAt,
      events: __DEV__ ? devtoolsEntryEvents(client.devtools, query.__id, keyArgs) : undefined,
      onSuccessData: onFetched,
      hasSubscribers: () => this.hasSubscribers(),
    })
  }

  /** See `ClientEntry.acquire`. */
  acquire(subscriberPath?: readonly string[]): void {
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
    if (subscriberPath !== undefined) {
      this.subscriptions += 1
      if (__DEV__)
        reportSubscriber(this.client.devtools, this.query, this.keyArgs, subscriberPath, true)
    }
  }

  /** See `ClientEntry.subscriptionCount`. */
  get subscriptionCount(): number {
    return this.subscriptions
  }

  /** See `ClientEntry.triggerEventRefetch`. A refetch re-fetches every loaded page. */
  private triggerEventRefetch(): void {
    if (this.entry.isFetching.peek()) return
    if (this.entry.isPaused.peek()) {
      this.entry.resumeParked()
      return
    }
    if (!this.entry.isStaleNow()) return
    this.entry.startFetch().catch(() => {
      /* error captured on entry */
    })
  }

  private stopEventSubscriptions(): void {
    this.unsubFocus?.()
    this.unsubFocus = null
    this.unsubOnline?.()
    this.unsubOnline = null
  }

  hasSubscribers(): boolean {
    return this.subscriberCount > 0
  }

  /** See `ClientEntry.release`. */
  release(subscriberPath?: readonly string[]): void {
    if (this.disposed) return
    this.subscriberCount -= 1
    if (subscriberPath !== undefined) {
      this.subscriptions -= 1
      if (__DEV__)
        reportSubscriber(this.client.devtools, this.query, this.keyArgs, subscriberPath, false)
    }
    if (this.subscriberCount <= 0) {
      if (this.subscriberCount === 0) this.client.emitActivity(this.query, this.keyArgs, false)
      this.stopIntervalTimer()
      this.stopEventSubscriptions()
      // The root is tearing down, and the client disposes every entry next: a
      // gc timer armed now would only be cancelled.
      if (this.client.isClosing) return
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
      // Join an in-flight fetch instead of aborting it (T3.2), and run a parked
      // one only once online — see `ClientEntry.armIntervalTick`.
      if (this.entry.isFetching.peek()) return
      if (this.entry.isPaused.peek()) {
        this.entry.resumeParked()
        return
      }
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
    this.disposed = true
    if (this.gcTimer != null) {
      this.gcTimer()
      this.gcTimer = null
    }
    this.stopIntervalTimer()
    this.stopEventSubscriptions()
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
  private readonly hydratedData = new Map<string, HydratedSlot>()
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
  /** Set by `close()`: the root is disposing its controllers, then this client. */
  private closing = false
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
        kind: query[BRAND] === 'infiniteQuery' ? 'infinite' : 'query',
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

  /**
   * Report a write to the plugins. `from` is the entry written: its
   * `serverState()` is the event's `server`, the truth beneath any live guess
   * (§13.1). Read only when a plugin listens.
   */
  private emitWrite(
    query: AnyQuery | AnyInfiniteQuery,
    key: readonly unknown[],
    data: unknown,
    updatedAt: number | undefined,
    source: WriteSource,
    origin: string | undefined,
    pageParams: readonly unknown[] | undefined,
    from: ServerSource,
  ): void {
    const plugins = this.plugins
    if (plugins === null || !plugins.listens('onWrite')) return
    const server = serverOf(from)
    plugins.emit('onWrite', {
      query: this.refOf(query),
      key,
      data,
      updatedAt: updatedAt ?? Date.now(),
      source,
      origin,
      ...(pageParams !== undefined ? { pageParams } : {}),
      ...(server !== undefined ? { server } : {}),
    })
  }

  /**
   * `emitWrite` for an infinite entry: the pages, with their params. `updatedAt`
   * defaults to the entry's `lastUpdatedAt`.
   */
  private emitInfiniteWrite(
    entry: InfiniteClientEntry<unknown, unknown, unknown>,
    source: WriteSource,
    origin: string | undefined,
    updatedAt: number | undefined = entry.entry.lastUpdatedAt.peek(),
  ): void {
    const pages = entry.entry.pages.peek()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      pages,
      updatedAt,
      source,
      origin,
      entry.entry.pageParams.peek(),
      entry.entry,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, pages, source)
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
          query[BRAND] === 'infiniteQuery'
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
      write: (id, key, updater, options) =>
        this.writeByKey(id, key, updater, 'write', origin, options?.pageParams),
      replace: (id, key, value, options) =>
        this.writeByKey(id, key, () => value, 'replace', origin, options?.pageParams),
      setData: (id, key, updater, options) => {
        const found = this.entryByKey(id, key)
        if (found === undefined) return undefined
        return found.kind === 'query'
          ? this.optimisticWrite(found.entry, updater, origin)
          : this.optimisticInfiniteWrite(
              found.entry,
              updater as (prev: unknown[] | undefined) => unknown[],
              origin,
              options?.pageParams,
            )
      },
      invalidate: (id, key) => {
        const found = this.entryByKey(id, key)
        if (found === undefined) return Promise.resolve()
        const { query, keyArgs } = found.entry
        // The same devtools event an app's `invalidate` sends, so a plugin's
        // invalidation shows on the timeline too.
        if (__DEV__) {
          this.devtools?.emit({ type: 'cache:invalidated', queryId: query.__id, queryKey: keyArgs })
        }
        const settled = this.invalidateEntry(found.entry)
        this.emitInvalidated(query, keyArgs, origin)
        return settled
      },
      hydrate: (state) => this.hydrateLive(state, origin),
      dehydrate: () => this.dehydrate(),
      hashKey: (key) => stableHash(key),
    }
  }

  /** Registered mutations, runnable by plugin `origin` (`PluginHost.mutations`). */
  mutationHost(origin: string): MutationHost {
    return {
      has: (id) => lookupRegisteredMutation(id) !== undefined,
      get: (id) => {
        const registered = lookupRegisteredMutation(id)
        return registered === undefined ? undefined : { id, meta: registered.definition.meta ?? {} }
      },
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
    if (query[BRAND] === 'infiniteQuery') {
      const entry = this.infiniteMaps.get(query as AnyInfiniteQuery)?.get(hash)
      return entry === undefined ? undefined : { kind: 'infinite', entry }
    }
    const entry = this.maps.get(query as AnyQuery)?.get(hash)
    return entry === undefined ? undefined : { kind: 'query', entry }
  }

  /**
   * A plugin's canonical write to an existing entry (`write` / `replace`). A
   * replace supersedes a fetch in flight only when it left the entry holding
   * data, for a regular and an infinite query alike: the rule the app-side
   * `replaceData` and `replaceInfiniteData` apply.
   */
  private writeByKey(
    id: string,
    key: readonly unknown[],
    updater: (prev: unknown) => unknown,
    source: 'write' | 'replace',
    origin: string,
    pageParams?: readonly unknown[],
  ): void {
    const found = this.entryByKey(id, key)
    if (found === undefined) return
    if (found.kind === 'query') {
      const { entry } = found
      entry.entry.setData(updater as (prev: unknown) => never, {
        track: false,
        whole: source === 'replace',
      })
      const data = entry.entry.data.peek()
      if (source === 'replace' && data !== undefined) {
        entry.entry.supersedeByWrite()
      }
      this.emitWrite(
        entry.query,
        entry.keyArgs,
        data,
        entry.entry.lastUpdatedAt.peek(),
        source,
        origin,
        undefined,
        entry.entry,
      )
      if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, source)
      return
    }
    const { entry } = found
    entry.entry.setData(updater as (prev: unknown[] | undefined) => unknown[], {
      track: false,
      whole: source === 'replace',
      pageParams,
    })
    if (source === 'replace' && entry.entry.data.peek() !== undefined) {
      entry.entry.supersedeByWrite()
    }
    this.emitInfiniteWrite(entry, source, origin)
  }

  private acceptsState(state: DehydratedState): boolean {
    if (state.version === 1 && Array.isArray(state.entries)) return true
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
  applyDehydratedEntry(dehydrated: DehydratedEntry, origin?: string): void {
    const { id: queryId, key: keyArgs, data, lastUpdatedAt, pageParams } = dehydrated
    const hash = stableHash(keyArgs)
    const query = this.byId.get(queryId)
    if (query !== undefined && query[BRAND] === 'query') {
      const entry = this.maps.get(query as AnyQuery)?.get(hash)
      if (entry !== undefined) {
        // A row older than the entry's data is skipped, and reports nothing.
        if (!entry.entry.applyHydration(data, lastUpdatedAt)) return
        const at = entry.entry.lastUpdatedAt.peek()
        this.emitWrite(
          entry.query,
          entry.keyArgs,
          data,
          at,
          'hydrate',
          origin,
          undefined,
          entry.entry,
        )
        if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'hydrate')
        return
      }
    }
    if (query !== undefined && query[BRAND] === 'infiniteQuery') {
      const entry = this.infiniteMaps.get(query as AnyInfiniteQuery)?.get(hash)
      const pages = infinitePayload(data, pageParams)
      if (entry !== undefined) {
        if (pages === undefined) return
        if (!entry.entry.applyHydration(pages.pages, pages.pageParams, lastUpdatedAt)) return
        this.emitInfiniteWrite(entry, 'hydrate', origin)
        return
      }
    }
    // No local entry yet — buffer in the same map the constructor uses.
    // The next bindEntry for this query + key will adopt the buffered payload
    // and clear the slot. Namespaced by queryId so a colliding-key query can't
    // steal it (spec §15, T1.2).
    this.bufferRow(hydrationKey(queryId, hash), { data, lastUpdatedAt, origin, pageParams })
  }

  /**
   * Buffer a row for a key no entry has bound yet. A row stamped before the
   * one already waiting for the key is dropped, as a bound entry drops a row
   * older than its data (§15).
   */
  private bufferRow(hkey: string, slot: HydratedSlot): void {
    const waiting = this.hydratedData.get(hkey)
    if (
      waiting !== undefined &&
      notInFuture(slot.lastUpdatedAt) < notInFuture(waiting.lastUpdatedAt)
    ) {
      return
    }
    this.hydratedData.set(hkey, slot)
  }

  /**
   * Apply a payload to a running root (`root.hydrate`, `host.queries.hydrate`):
   * bound entries take it now, unbound ones buffer it. A payload of another
   * version is dropped with a warning, as at `createRoot`.
   */
  hydrateLive(state: DehydratedState, origin?: string): void {
    if (!this.acceptsState(state)) return
    this.eachHydrationEntry(state, (e) => this.applyDehydratedEntry(e, origin))
  }

  /** Buffer a payload for entries not bound yet (`RootOptions.hydrate`). */
  hydrate(state: DehydratedState): void {
    if (!this.acceptsState(state)) return
    this.eachHydrationEntry(state, (entry) => {
      const hash = stableHash(entry.key)
      this.bufferRow(hydrationKey(entry.id, hash), {
        data: entry.data,
        lastUpdatedAt: entry.lastUpdatedAt,
        origin: undefined,
        pageParams: entry.pageParams,
      })
    })
  }

  /**
   * Apply `apply` to each entry, skipping any that is malformed or that throws.
   * A payload can come from storage a user edited (`persistQueryCachePlugin`),
   * and one bad entry, such as a key nested deep enough to overflow
   * `stableHash`, must not fail `createRoot` for the rest.
   */
  private eachHydrationEntry(
    state: DehydratedState,
    apply: (entry: DehydratedEntry) => void,
  ): void {
    for (const entry of state.entries as readonly unknown[]) {
      try {
        if (!isHydrationEntry(entry)) throw new TypeError('not a dehydrated entry')
        apply(entry)
      } catch (err) {
        if (__DEV__) console.warn('[olas] hydrate(): skipped a malformed entry.', err)
      }
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
          queryId: ce.query.__id,
          key: ce.keyArgs as readonly unknown[],
          status: ce.entry.status.peek(),
          data: ce.entry.data.peek(),
          error: ce.entry.error.peek(),
          lastUpdatedAt: ce.entry.lastUpdatedAt.peek(),
          isStale: ce.entry.isStale.peek(),
          isFetching: ce.entry.isFetching.peek(),
          hasPendingMutations: ce.entry.hasPendingMutations.peek(),
          subscribers: ce.subscriptionCount,
        })
      }
    }
    for (const map of this.infiniteMaps.values()) {
      for (const ce of map.values()) {
        out.push({
          queryId: ce.query.__id,
          key: ce.keyArgs as readonly unknown[],
          status: ce.entry.status.peek(),
          // Infinite entries carry an array of pages; expose them verbatim.
          data: ce.entry.pages.peek(),
          error: ce.entry.error.peek(),
          lastUpdatedAt: ce.entry.lastUpdatedAt.peek(),
          isStale: ce.entry.isStale.peek(),
          isFetching: ce.entry.isFetching.peek(),
          hasPendingMutations: ce.entry.hasPendingMutations.peek(),
          subscribers: ce.subscriptionCount,
        })
      }
    }
    return out
  }

  /**
   * Every entry's server truth, stamped with the time the server last said it
   * (`Entry.serverState`). `status` alone is not the test: it reads `'pending'`
   * over the data during a background refetch, and `'error'` over it after a
   * failed one (§5.3, §15). Under a live optimistic write the row carries the
   * data beneath it, so a guess never ships as server truth, and the stamp is
   * never moved by a guess.
   */
  dehydrate(): DehydratedState {
    const entries: DehydratedState['entries'] = []
    for (const [query, map] of this.maps) {
      for (const ce of map.values()) {
        const row = ce.entry.serverState()
        if (row === null) continue
        entries.push({
          id: query.__id,
          key: ce.keyArgs,
          data: row.data,
          lastUpdatedAt: row.updatedAt,
        })
      }
    }
    for (const [query, map] of this.infiniteMaps) {
      for (const ce of map.values()) {
        const row = ce.entry.serverState()
        if (row === null) continue
        entries.push({
          id: query.__id,
          key: ce.keyArgs,
          data: row.pages,
          pageParams: row.pageParams,
          lastUpdatedAt: row.updatedAt,
        })
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
    if (query[BRAND] === 'infiniteQuery') {
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
        | (HydratedSlot & { data: T; lastUpdatedAt: number })
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
          undefined,
          created.entry,
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
          created.entry.lastUpdatedAt.peek(),
          'hydrate',
          hydrated.origin,
          undefined,
          created.entry,
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
        if (!sameCallArg(prev[i], args[i])) mismatch = true
      }
      if (mismatch) {
        // eslint-disable-next-line no-console
        console.warn(
          `[olas] bindEntry: hash collision with diverging callArgs for query` +
            ` ${internal.__spec.id} key=${describeKey(keyArgs)}.` +
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
    entry: {
      invalidate(): Promise<unknown>
      markStale(): void
      failureOf(err: unknown): { attempt: number; cause?: unknown } | undefined
    }
  }): Promise<void> {
    if (entry.hasSubscribers()) {
      // Resolve when the triggered refetch settles. Errors are reported through
      // `onError` (as before) and swallowed for the awaiter, so `await invalidate()`
      // never throws — it means "the refetch this invalidate kicked off has finished",
      // matching TanStack's `invalidateQueries`. When a `replace` discarded that
      // refetch and the entry caught up, the entry's promise follows the catch-up,
      // so this settles with the fetch that reconciled (§6.4).
      return entry.entry.invalidate().then(
        () => {},
        (err) => {
          if (isAbortError(err)) return
          dispatchError(this.onError, err, {
            kind: 'cache',
            controllerPath: [],
            queryId: entry.query.__id,
            key: entry.keyArgs,
            // The retry attempt that failed last, and the fetch error a throwing
            // retry callback replaced.
            ...entry.entry.failureOf(err),
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
      undefined,
      entry.entry,
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
   * until `staleTime` lapses. Superseding is a no-op when nothing is fetching.
   *
   * When the discarded fetch was an invalidation's, the entry re-fetches once to reconcile
   * (`Entry.supersedeByWrite`).
   */
  replaceData<Args extends unknown[], T>(
    query: Query<Args, T>,
    args: Args,
    value: T,
    origin?: string,
  ): void {
    const entry = this.bindEntry(query, args)
    entry.entry.setData(() => value, { track: false, whole: true })
    if (value !== undefined) entry.entry.supersedeByWrite()
    const data = entry.entry.data.peek()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      data,
      entry.entry.lastUpdatedAt.peek(),
      'replace',
      origin,
      undefined,
      entry.entry,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'replace')
  }

  setData<Args extends unknown[], T>(
    query: Query<Args, T>,
    args: Args,
    updater: (prev: T | undefined) => T,
    origin?: string,
  ): Snapshot {
    return this.optimisticWrite(this.bindEntry(query, args), updater, origin)
  }

  /**
   * An optimistic write of one entry, and the `Snapshot` that settles it:
   * `setData`'s body, shared with a plugin's `host.queries.setData`.
   */
  private optimisticWrite<T>(
    entry: ClientEntry<T>,
    updater: (prev: T | undefined) => T,
    origin: string | undefined,
  ): Snapshot {
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
      undefined,
      entry.entry,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'optimistic')
    // Report the rollback too, so plugins that mirrored the optimistic value
    // (cross-tab, entities) drop it (T3.6). Only when data actually changed: a
    // rollback below the top replays the layers above it (§6.4), and a replay
    // that changes nothing keeps the data's reference.
    // A settle that leaves no live layer after a commit reports `'commit'`
    // instead (`Entry.settleReport`, §13.1).
    return {
      rollback: () => {
        const before = entry.entry.data.peek()
        const report = snapshot.rollback()
        const after = entry.entry.data.peek()
        if (report === 'commit') this.emitCommit(entry, origin)
        else if (!Object.is(before, after)) {
          this.emitWrite(
            entry.query,
            entry.keyArgs,
            after,
            entry.entry.lastUpdatedAt.peek(),
            'rollback',
            origin,
            undefined,
            entry.entry,
          )
          if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, after, 'rollback')
        }
      },
      finalize: () => {
        if (snapshot.finalize() === 'commit') this.emitCommit(entry, origin)
      },
    }
  }

  /**
   * Report committed data as `'commit'`: the data on screen once no optimistic
   * layer is live, stamped with the server clock, which a commit does not move
   * (§5.9, §13.1). `0` when the server never answered.
   */
  private emitCommit<T>(entry: ClientEntry<T>, origin: string | undefined): void {
    const data = entry.entry.data.peek()
    this.emitWrite(
      entry.query,
      entry.keyArgs,
      data,
      entry.entry.serverStamp() ?? 0,
      'commit',
      origin,
      undefined,
      entry.entry,
    )
    if (__DEV__) this.emitDevtoolsSetData(entry.query, entry.keyArgs, data, 'commit')
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
      // Adopt a buffered hydration payload, as `bindEntry` does. Only one that
      // carries aligned `pageParams`: a regular-shaped payload under an
      // infinite query's id cannot seed pages.
      const hkey = hydrationKey(internal.__id, hash)
      const slot = this.hydratedData.get(hkey)
      if (slot !== undefined) this.hydratedData.delete(hkey)
      const payload = slot === undefined ? undefined : infinitePayload(slot.data, slot.pageParams)
      const hydrated =
        payload === undefined || slot === undefined
          ? undefined
          : {
              pages: payload.pages as TPage[],
              pageParams: payload.pageParams,
              lastUpdatedAt: slot.lastUpdatedAt,
            }
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
          created.entry.pageParams.peek(),
          created.entry,
        )
      const created: InfiniteClientEntry<TPage, TItem, unknown> = new InfiniteClientEntry<
        TPage,
        TItem,
        unknown
      >(this, internal, args, keyArgs, internal.__spec, hydrated, onFetched)
      entry = created
      map.set(hash, entry as InfiniteClientEntry<unknown, unknown, unknown>)
      entry.scheduleGcIfOrphan()
      if (hydrated !== undefined && slot !== undefined) {
        this.emitInfiniteWrite(
          entry as InfiniteClientEntry<unknown, unknown, unknown>,
          'hydrate',
          slot.origin,
        )
      }
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

  /** The infinite counterpart of `peekData`: non-creating and untracked. */
  peekInfiniteData<Args extends unknown[], TPage>(
    query: InfiniteQuery<Args, TPage, any>,
    args: Args,
  ): TPage[] | undefined {
    const internal = query as AnyInfiniteQuery
    const map = this.infiniteMaps.get(internal)
    if (!map) return undefined
    const pages = map.get(stableHash(internal.__spec.key(...args)))?.entry.pages.peek()
    return pages === undefined || pages.length === 0 ? undefined : (pages as TPage[])
  }

  /**
   * The infinite counterpart of `writeData`: a canonical patch that leaves an
   * in-flight fetch alone (see `writeData` for why a patch must not supersede).
   */
  writeInfiniteData<Args extends unknown[], TPage>(
    query: InfiniteQuery<Args, TPage, any>,
    args: Args,
    updater: (prev: TPage[] | undefined) => TPage[],
    origin?: string,
  ): void {
    const entry = this.bindInfiniteEntry(query, args)
    entry.entry.setData(updater, { track: false })
    this.emitInfiniteWrite(entry as InfiniteClientEntry<unknown, unknown, unknown>, 'write', origin)
  }

  /**
   * The infinite counterpart of `replaceData`: the pages are the record, so a
   * fetch already in flight is superseded — only when the entry then holds a
   * page, for the reason `replaceData` gives. An empty pages array is how an
   * infinite entry spells "nothing here" (`peek` reads it as `undefined`).
   */
  replaceInfiniteData<Args extends unknown[], TPage>(
    query: InfiniteQuery<Args, TPage, any>,
    args: Args,
    value: TPage[],
    origin?: string,
  ): void {
    const entry = this.bindInfiniteEntry(query, args)
    entry.entry.setData(() => value, { track: false, whole: true })
    if (entry.entry.data.peek() !== undefined) entry.entry.supersedeByWrite()
    this.emitInfiniteWrite(
      entry as InfiniteClientEntry<unknown, unknown, unknown>,
      'replace',
      origin,
    )
  }

  setInfiniteData<Args extends unknown[], TPage>(
    query: InfiniteQuery<Args, TPage, any>,
    args: Args,
    updater: (prev: TPage[] | undefined) => TPage[],
    origin?: string,
  ): Snapshot {
    return this.optimisticInfiniteWrite(
      this.bindInfiniteEntry(query, args) as InfiniteClientEntry<unknown, unknown, unknown>,
      updater as (prev: unknown[] | undefined) => unknown[],
      origin,
      undefined,
    )
  }

  /**
   * An optimistic write of one infinite entry, and the `Snapshot` that settles
   * it: `setInfiniteData`'s body, shared with `host.queries.setData`.
   */
  private optimisticInfiniteWrite(
    entry: InfiniteClientEntry<unknown, unknown, unknown>,
    updater: (prev: unknown[] | undefined) => unknown[],
    origin: string | undefined,
    pageParams: readonly unknown[] | undefined,
  ): Snapshot {
    const snapshot = entry.entry.setData(
      updater,
      pageParams !== undefined ? { pageParams } : undefined,
    )
    const any = entry
    this.emitInfiniteWrite(any, 'optimistic', origin)
    // Report the rollback so plugins mirroring the optimistic pages drop them
    // (T3.6); only on an actual change, as `optimisticWrite` does. A commit
    // reports as `setData` does.
    const commit = (): void =>
      this.emitInfiniteWrite(any, 'commit', origin, entry.entry.serverStamp() ?? 0)
    return {
      rollback: () => {
        const before = entry.entry.pages.peek()
        const report = snapshot.rollback()
        if (report === 'commit') commit()
        else if (!Object.is(before, entry.entry.pages.peek())) {
          this.emitInfiniteWrite(any, 'rollback', origin)
        }
      },
      finalize: () => {
        if (snapshot.finalize() === 'commit') commit()
      },
    }
  }

  /** The infinite counterpart of `prefetch`, settling with the first page. */
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
      // Join a request in flight rather than restarting it, as `prefetch` does.
      if (entry.entry.isFetching.peek()) return (await entry.entry.settled())[0] as TPage
      return entry.entry.startFetch().catch(async (err: unknown) => {
        if (isAbortError(err)) return (await entry.entry.settled())[0] as TPage
        throw err
      })
    })()
    return promise.finally(() => entry.release())
  }

  /**
   * Fetch into the cache without subscribing, holding the entry until the
   * fetch settles. A fresh entry resolves with its data at once. A fetch
   * already in flight is joined, not restarted.
   */
  prefetch<Args extends unknown[], T>(query: Query<Args, T>, args: Args): Promise<T> {
    const entry = this.bindEntry(query, args)
    entry.acquire()
    const promise = (async () => {
      const status = entry.entry.status.peek()
      if (status === 'success' && !entry.entry.isStaleNow()) {
        return entry.entry.data.peek() as T
      }
      if (entry.entry.isFetching.peek()) {
        return entry.entry.settled()
      }
      return entry.entry.startFetch().catch((err) => {
        // A supersede aborts this fetch without it being a failure — a newer refetch, a key
        // change, or a canonical `write` landing while this was outstanding (§6.4). Don't
        // surface the spurious AbortError: settle with whatever the entry settles on, which
        // is what `subscription.refetch` does too (`use.ts`) and what an awaiting SSR loader
        // needs. Real errors still reject, and so does a `cancel()` that leaves the entry
        // without data: nothing is coming to fill it, and waiting would hold the entry forever.
        if (isAbortError(err)) return entry.entry.settled()
        throw err
      })
    })()
    return promise.finally(() => entry.release())
  }

  /**
   * The root is about to dispose its controllers, and this client after them.
   * Their subscriptions release entries on the way out; `close` tells those
   * releases not to arm gc timers `dispose` would cancel straight away.
   */
  close(): void {
    this.closing = true
  }

  get isClosing(): boolean {
    return this.closing
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
