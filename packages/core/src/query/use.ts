import { computed, effect, type Signal, signal, untracked } from '../signals'
import { readOnly } from '../signals/readonly'
import type { ReadSignal } from '../signals/types'
import { isAbortError } from '../utils'
import type { ClientEntry, InfiniteClientEntry, QueryClient } from './client'
import { QueryDisabledError } from './errors'
import type { InfiniteQuery, InfiniteQuerySpec, InfiniteQuerySubscription } from './infinite'
import type {
  AsyncStatus,
  Query,
  QuerySpec,
  QuerySubscription,
  QuerySubscriptionOptions,
  SubscriptionInternalOptions,
} from './types'

type QueryInternal<Args extends unknown[], T> = Query<Args, T> & {
  readonly __spec: QuerySpec<Args, T>
}

const disposedError = (): DOMException => new DOMException('Subscription disposed', 'AbortError')

/**
 * The entry-less half of a subscription's lifetime. A subscription is
 * detached while its `enabled` is false; `firstValue()` called then waits here
 * for the next attach instead of rejecting, so suspense on a dependent query
 * suspends until the query is enabled and loaded. Dispose rejects every waiter.
 */
class AttachWaiters<E> {
  private waiters: Array<{ resolve: (entry: E) => void; reject: (err: unknown) => void }> = []
  closed = false

  wait(): Promise<E> {
    if (this.closed) return Promise.reject(disposedError())
    return new Promise<E>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  attached(entry: E): void {
    const ws = this.waiters
    this.waiters = []
    for (const w of ws) w.resolve(entry)
  }

  close(): void {
    this.closed = true
    const ws = this.waiters
    this.waiters = []
    for (const w of ws) w.reject(disposedError())
  }
}

/**
 * One `firstValue()` promise per attached entry, reused while it is pending, so
 * a suspended render that asks again gets the promise it already threw.
 */
class FirstValueCache<E, V> {
  private cached: { entry: E | null; promise: Promise<V> } | null = null

  get(entry: E | null, make: () => Promise<V>): Promise<V> {
    if (this.cached !== null && this.cached.entry === entry) return this.cached.promise
    const promise = make()
    const slot = { entry, promise }
    this.cached = slot
    const clear = (): void => {
      if (this.cached === slot) this.cached = null
    }
    promise.then(clear, clear)
    return promise
  }
}

class SubscriptionImpl<T, U = T> implements QuerySubscription<U> {
  private readonly current$: Signal<ClientEntry<T> | null> = signal(null)
  private readonly previousData$: Signal<T | undefined> = signal(undefined)
  private readonly enabled$: Signal<boolean> = signal(true)
  private readonly waiters = new AttachWaiters<ClientEntry<T>>()
  private readonly firstValues = new FirstValueCache<ClientEntry<T>, U>()
  /** The unprojected value `data` shows, the retained snapshot included. */
  private readonly rawData: ReadSignal<T | undefined>

  readonly data: ReadSignal<U | undefined>
  readonly error: ReadSignal<unknown | undefined>
  readonly status: ReadSignal<AsyncStatus>
  readonly isLoading: ReadSignal<boolean>
  readonly isFetching: ReadSignal<boolean>
  readonly isStale: ReadSignal<boolean>
  readonly lastUpdatedAt: ReadSignal<number | undefined>
  readonly hasPendingMutations: ReadSignal<boolean>
  readonly isPaused: ReadSignal<boolean>
  readonly isEnabled: ReadSignal<boolean> = readOnly(this.enabled$)

  constructor(
    private readonly queryId: string,
    private readonly keepPreviousData: boolean,
    private readonly select?: (data: T) => U,
    private readonly keepDataWhileDisabled: boolean = false,
  ) {
    // The underlying entry stores `T`. The subscription's `data` is `U`
    // (or `T` when no projection). We compute the raw `T` once, then layer
    // `select` in a second computed so the projection's `Object.is` dedup
    // applies BEFORE downstream subscribers run — combined with structural
    // sharing on the entry, an unchanged payload + a stable `select`
    // outputs the same `U` reference and doesn't churn the React tree.
    // The retained snapshot fills in for two transitions, each under its own
    // flag: a key change while attached (`keepPreviousData`) and a disable
    // while detached (`keepDataWhileDisabled`). Either flag alone never reaches
    // across to the other transition (§5.2).
    const rawData = computed(() => {
      const cur = this.current$.value
      if (cur === null) return this.keepDataWhileDisabled ? this.previousData$.value : undefined
      const curData = cur.entry.data.value
      if (curData !== undefined) return curData
      return keepPreviousData ? this.previousData$.value : undefined
    })
    this.rawData = rawData
    this.data =
      select === undefined
        ? (rawData as unknown as ReadSignal<U | undefined>)
        : computed<U | undefined>(() => {
            const raw = rawData.value
            return raw === undefined ? undefined : select(raw)
          })
    this.error = computed(() => this.current$.value?.entry.error.value)
    this.status = computed<AsyncStatus>(() => this.current$.value?.entry.status.value ?? 'idle')
    this.isLoading = computed(() => {
      const cur = this.current$.value
      if (!cur) return false
      if (keepPreviousData && this.previousData$.value !== undefined) return false
      return cur.entry.isLoading.value
    })
    this.isFetching = computed(() => this.current$.value?.entry.isFetching.value ?? false)
    this.isStale = computed(() => this.current$.value?.entry.isStale.value ?? true)
    this.lastUpdatedAt = computed(() => this.current$.value?.entry.lastUpdatedAt.value)
    this.hasPendingMutations = computed(
      () => this.current$.value?.entry.hasPendingMutations.value ?? false,
    )
    this.isPaused = computed(() => this.current$.value?.entry.isPaused.value ?? false)
  }

  attach(entry: ClientEntry<T>): void {
    const prev = this.current$.peek()
    if (prev === entry) return
    if (prev && this.keepPreviousData) {
      const prevData = prev.entry.data.peek()
      if (prevData !== undefined) this.previousData$.set(prevData)
    }
    this.current$.set(entry)
    this.waiters.attached(entry)
  }

  setEnabled(enabled: boolean): void {
    this.enabled$.set(enabled)
  }

  /**
   * Unbind on a disable. The data on screen at that moment, a bridged
   * `keepPreviousData` value included, becomes the retained snapshot:
   * `keepDataWhileDisabled` shows it while disabled, and `keepPreviousData`
   * bridges a re-enable on a new key with it. A no-op when already detached,
   * so a second disable keeps the first snapshot.
   */
  disable(): void {
    if (this.current$.peek() === null) return
    if (this.keepPreviousData || this.keepDataWhileDisabled) {
      this.previousData$.set(this.rawData.peek())
    }
    this.current$.set(null)
  }

  /** Dispose: detach and reject every `firstValue()` still waiting to attach. */
  close(): void {
    this.current$.set(null)
    this.waiters.close()
  }

  refetch = (): Promise<U> => {
    const cur = this.current$.peek()
    if (!cur) {
      if (this.waiters.closed) return Promise.reject(disposedError())
      return Promise.reject(new QueryDisabledError(this.queryId))
    }
    return cur.entry.refetch().then(
      (v) => this.project(v),
      (err) => {
        // A supersede (a newer refetch, a hydration, a `replace`) aborts this
        // fetch. Don't surface the spurious AbortError — settle with the
        // superseding fetch's eventual outcome instead (T3.9). Not
        // `firstValue()`: it resolves at once with the data on hand, which is
        // what the superseding fetch is replacing. Real errors still reject,
        // and so does a `cancel()` that leaves no data.
        if (isAbortError(err)) return cur.entry.settled().then((v) => this.project(v))
        throw err
      },
    )
  }

  reset = (): void => {
    this.current$.peek()?.entry.reset()
  }

  cancel = (): void => {
    this.current$.peek()?.entry.cancel()
  }

  firstValue = (): Promise<U> => {
    const cur = this.current$.peek()
    return this.firstValues.get(cur, () =>
      (cur !== null ? Promise.resolve(cur) : this.waiters.wait())
        .then((entry) => entry.entry.firstValue())
        .then((v) => this.project(v)),
    )
  }

  private project(v: T): U {
    return this.select === undefined ? (v as unknown as U) : this.select(v)
  }
}

/**
 * Build a subscription + the effect that keeps it bound to the right entry.
 * The controller container wires the disposer into the lifecycle.
 *
 * `keyOrOptions` may carry an optional `select` projection that maps the
 * underlying `T` to a view `U`; the returned subscription's data shape
 * widens accordingly. Without `select`, `U = T` and the projection
 * computed is skipped.
 *
 * `subscriberPath` is the subscribing controller's path. Every acquire and
 * release carries it, so the devtools see who holds each entry.
 */
export function createUse<Args extends unknown[], T, U = T>(
  client: QueryClient,
  query: Query<Args, T>,
  keyOrOptions: (() => Args) | SubscriptionInternalOptions<Args, T, U> | undefined,
  subscriberPath: readonly string[],
): {
  subscription: QuerySubscription<U>
  dispose: () => void
  /** Suspend the subscription — release the entry (its refetchInterval +
   *  focus/online listeners pause) without disposing it. Spec §4.1. */
  suspend: () => void
  /**
   * Resume after `suspend`. Re-acquires the entry and refetches if stale.
   */
  resume: () => void
} {
  const internal = query as unknown as QueryInternal<Args, T>
  const spec = internal.__spec
  const keepPreviousData = spec.keepPreviousData ?? client.defaults.keepPreviousData ?? false

  const keyFn = typeof keyOrOptions === 'function' ? keyOrOptions : keyOrOptions?.key
  const enabledFn =
    typeof keyOrOptions === 'object' && keyOrOptions !== null ? keyOrOptions.enabled : undefined
  const select =
    typeof keyOrOptions === 'object' && keyOrOptions !== null ? keyOrOptions.select : undefined
  const keepDataWhileDisabled =
    typeof keyOrOptions === 'object' && keyOrOptions !== null
      ? (keyOrOptions.keepDataWhileDisabled ?? false)
      : false

  const sub = new SubscriptionImpl<T, U>(spec.id, keepPreviousData, select, keepDataWhileDisabled)
  let currentEntry: ClientEntry<T> | null = null
  let suspended = false

  const effectDispose = effect(() => {
    // Read tracked signals (enabled, then key when enabled) BEFORE the
    // `suspended` early-return, so the effect keeps its dependency set while
    // suspended. Otherwise a key/enabled change during suspension re-runs the
    // effect, it reads nothing, its deps go empty, and it stays inert forever
    // — resume() then only rebinds to the key as of suspend time, silently
    // dropping every later change (T2.1). Key is read only when enabled,
    // preserving the `enabled`-guards-`key` pattern (the key thunk may deref
    // state that only exists once enabled).
    const isEnabled = enabledFn ? enabledFn() : true
    const args = isEnabled ? ((keyFn ? keyFn() : ([] as unknown as Args)) as Args) : undefined

    if (suspended) return

    if (!isEnabled) {
      untracked(() => {
        sub.setEnabled(false)
        if (currentEntry) {
          currentEntry.release(subscriberPath)
          currentEntry = null
        }
        // `keepDataWhileDisabled` keeps reporting the last data while disabled;
        // otherwise the subscription blanks (§5.2).
        sub.disable()
      })
      return
    }

    untracked(() => {
      sub.setEnabled(true)
      const entry = client.bindEntry<Args, T>(query, args as Args)
      if (currentEntry === entry) return
      if (currentEntry) currentEntry.release(subscriberPath)
      entry.acquire(subscriberPath)
      currentEntry = entry
      sub.attach(entry)

      const status = entry.entry.status.peek()
      const fetching = entry.entry.isFetching.peek()
      if (!fetching && (status === 'idle' || entry.entry.isStaleNow() || status === 'error')) {
        entry.entry.startFetch().catch(() => {
          /* error captured on entry */
        })
      }
    })
  })

  const dispose = () => {
    effectDispose()
    if (currentEntry) {
      currentEntry.release(subscriberPath)
      currentEntry = null
    }
    sub.close()
  }

  const suspend = (): void => {
    if (suspended) return
    suspended = true
    if (currentEntry) {
      currentEntry.release(subscriberPath)
      currentEntry = null
    }
    // Keep subscription detached so reads return the last committed values
    // via the entry's signals if still alive (the entry may be gc'd after
    // its gcTime; that's fine — resume re-binds).
  }

  const resume = (): void => {
    if (!suspended) return
    suspended = false
    // Re-evaluate the keyFn + enabled flag and rebind. The effect's deps
    // didn't change while suspended, so toggling `suspended` here doesn't
    // re-fire the effect on its own — force a sync rebind through the same
    // code path.
    const isEnabled = enabledFn ? enabledFn() : true
    if (!isEnabled) {
      // Disabled while suspended: settle into the disabled state now, exactly
      // as the effect would have on the change (§5.2). The entry was released
      // at suspend.
      sub.setEnabled(false)
      sub.disable()
      return
    }
    sub.setEnabled(true)
    const args = (keyFn ? keyFn() : ([] as unknown as Args)) as Args
    const entry = client.bindEntry<Args, T>(query, args)
    entry.acquire(subscriberPath)
    currentEntry = entry
    sub.attach(entry)
    // On resume, refetch if stale (matches the spec §4.1 "stale-on-resume"
    // requirement). Non-stale data stays as-is. A fetch already in flight is
    // joined, as on the effect path: restarting it would abort a request the
    // entry is about to receive.
    const status = entry.entry.status.peek()
    const fetching = entry.entry.isFetching.peek()
    if (!fetching && (status === 'idle' || entry.entry.isStaleNow() || status === 'error')) {
      entry.entry.startFetch().catch(() => {
        /* error captured on entry */
      })
    }
  }

  return { subscription: sub, dispose, suspend, resume }
}

type InfiniteQueryInternal<Args extends unknown[], TPage, TItem> = InfiniteQuery<
  Args,
  TPage,
  TItem
> & {
  readonly __spec: InfiniteQuerySpec<Args, any, TPage, TItem>
}

class InfiniteSubscriptionImpl<TPage, TItem> implements InfiniteQuerySubscription<TPage, TItem> {
  private readonly current$: Signal<InfiniteClientEntry<TPage, TItem, unknown> | null> =
    signal(null)
  private readonly previousPages$: Signal<TPage[] | undefined> = signal(undefined)
  private readonly enabled$: Signal<boolean> = signal(true)
  private readonly waiters = new AttachWaiters<InfiniteClientEntry<TPage, TItem, unknown>>()
  private readonly firstValues = new FirstValueCache<
    InfiniteClientEntry<TPage, TItem, unknown>,
    TPage[]
  >()
  /** The pages retained in place of the entry's, while they are shown. */
  private readonly retained: ReadSignal<TPage[] | undefined>
  private readonly keepDataWhileDisabled: boolean

  readonly data: ReadSignal<TPage[] | undefined>
  readonly pages: ReadSignal<TPage[]>
  readonly flat: ReadSignal<TItem[]>
  readonly error: ReadSignal<unknown | undefined>
  readonly status: ReadSignal<AsyncStatus>
  readonly isLoading: ReadSignal<boolean>
  readonly isFetching: ReadSignal<boolean>
  readonly isStale: ReadSignal<boolean>
  readonly lastUpdatedAt: ReadSignal<number | undefined>
  readonly hasPendingMutations: ReadSignal<boolean>
  readonly isPaused: ReadSignal<boolean>
  readonly hasNextPage: ReadSignal<boolean>
  readonly hasPreviousPage: ReadSignal<boolean>
  readonly isFetchingNextPage: ReadSignal<boolean>
  readonly isFetchingPreviousPage: ReadSignal<boolean>
  readonly isEnabled: ReadSignal<boolean> = readOnly(this.enabled$)

  constructor(
    private readonly queryId: string,
    private readonly keepPreviousData: boolean,
    keepDataWhileDisabled = false,
    itemsOf?: (page: TPage) => TItem[],
  ) {
    // Retained pages fill in for two transitions, each under its own flag: a
    // key change while attached (`keepPreviousData`) and a disable while
    // detached (`keepDataWhileDisabled`). As in `SubscriptionImpl`.
    const retained = computed<TPage[] | undefined>(() => {
      const cur = this.current$.value
      if (cur !== null && cur.entry.pages.value.length > 0) return undefined
      if (!(cur === null ? keepDataWhileDisabled : keepPreviousData)) return undefined
      const prev = this.previousPages$.value
      return prev && prev.length > 0 ? prev : undefined
    })
    this.retained = retained
    this.keepDataWhileDisabled = keepDataWhileDisabled
    this.pages = computed(() => retained.value ?? this.current$.value?.entry.pages.value ?? [])
    this.data = computed(() => {
      const kept = retained.value
      if (kept !== undefined) return kept
      const ps = this.current$.value?.entry.pages.value
      return ps && ps.length > 0 ? ps : undefined
    })
    // `flat` follows `pages`: while retained pages are showing, it flattens
    // those, so the two never disagree about what is on screen.
    this.flat = computed(() => {
      const kept = retained.value
      if (kept !== undefined) return itemsOf ? kept.flatMap(itemsOf) : (kept as unknown as TItem[])
      return this.current$.value?.entry.flat.value ?? []
    })
    this.error = computed(() => this.current$.value?.entry.error.value)
    this.status = computed<AsyncStatus>(() => this.current$.value?.entry.status.value ?? 'idle')
    this.isLoading = computed(() => {
      const cur = this.current$.value
      if (!cur) return false
      if (retained.value !== undefined) return false
      return cur.entry.isLoading.value
    })
    this.isFetching = computed(() => this.current$.value?.entry.isFetching.value ?? false)
    this.isStale = computed(() => this.current$.value?.entry.isStale.value ?? true)
    this.lastUpdatedAt = computed(() => this.current$.value?.entry.lastUpdatedAt.value)
    this.hasPendingMutations = computed(
      () => this.current$.value?.entry.hasPendingMutations.value ?? false,
    )
    this.isPaused = computed(() => this.current$.value?.entry.isPaused.value ?? false)
    this.hasNextPage = computed(() => this.current$.value?.entry.hasNextPage.value ?? false)
    this.hasPreviousPage = computed(() => this.current$.value?.entry.hasPreviousPage.value ?? false)
    this.isFetchingNextPage = computed(
      () => this.current$.value?.entry.isFetchingNextPage.value ?? false,
    )
    this.isFetchingPreviousPage = computed(
      () => this.current$.value?.entry.isFetchingPreviousPage.value ?? false,
    )
  }

  attach(entry: InfiniteClientEntry<TPage, TItem, unknown>): void {
    const prev = this.current$.peek()
    if (prev === entry) return
    if (prev && this.keepPreviousData) {
      const prevPages = prev.entry.pages.peek()
      if (prevPages.length > 0) this.previousPages$.set(prevPages)
    }
    this.current$.set(entry)
    this.waiters.attached(entry)
  }

  setEnabled(enabled: boolean): void {
    this.enabled$.set(enabled)
  }

  /** Dispose: detach and reject every `firstValue()` still waiting to attach. */
  close(): void {
    this.current$.set(null)
    this.waiters.close()
  }

  /** Unbind on a disable, retaining the pages on screen. See `SubscriptionImpl.disable`. */
  disable(): void {
    const cur = this.current$.peek()
    if (cur === null) return
    if (this.keepPreviousData || this.keepDataWhileDisabled) {
      const ps = cur.entry.pages.peek()
      this.previousPages$.set(this.retained.peek() ?? (ps.length > 0 ? ps : undefined))
    }
    this.current$.set(null)
  }

  refetch = (): Promise<TPage[]> => {
    const cur = this.current$.peek()
    if (!cur) {
      if (this.waiters.closed) return Promise.reject(disposedError())
      return Promise.reject(new QueryDisabledError(this.queryId))
    }
    return cur.entry.refetch().then(
      () => cur.entry.pages.peek(),
      (err) => {
        // Supersede → settle with the superseder's outcome, not AbortError
        // (T3.9). `settled()`, not `firstValue()`: see `SubscriptionImpl.refetch`.
        if (isAbortError(err)) return cur.entry.settled()
        throw err
      },
    )
  }

  reset = (): void => {
    this.current$.peek()?.entry.reset()
  }

  cancel = (): void => {
    this.current$.peek()?.entry.cancel()
  }

  firstValue = (): Promise<TPage[]> => {
    const cur = this.current$.peek()
    return this.firstValues.get(cur, () =>
      (cur !== null ? Promise.resolve(cur) : this.waiters.wait()).then((entry) =>
        entry.entry.firstValue(),
      ),
    )
  }

  fetchNextPage = (): Promise<void> => {
    const cur = this.current$.peek()
    if (!cur) return Promise.resolve()
    return cur.entry.fetchNextPage()
  }

  fetchPreviousPage = (): Promise<void> => {
    const cur = this.current$.peek()
    if (!cur) return Promise.resolve()
    return cur.entry.fetchPreviousPage()
  }
}

/** The infinite counterpart of `createUse`, with the same `subscriberPath`. */
export function createInfiniteUse<Args extends unknown[], TPage, TItem>(
  client: QueryClient,
  query: InfiniteQuery<Args, TPage, TItem>,
  keyOrOptions: (() => Args) | QuerySubscriptionOptions<Args> | undefined,
  subscriberPath: readonly string[],
): {
  subscription: InfiniteQuerySubscription<TPage, TItem>
  dispose: () => void
  suspend: () => void
  resume: () => void
} {
  const spec = (query as unknown as InfiniteQueryInternal<Args, TPage, TItem>).__spec
  const keepPreviousData = spec.keepPreviousData ?? client.defaults.keepPreviousData ?? false
  const keyFn = typeof keyOrOptions === 'function' ? keyOrOptions : keyOrOptions?.key
  const enabledFn =
    typeof keyOrOptions === 'object' && keyOrOptions !== null ? keyOrOptions.enabled : undefined
  const keepDataWhileDisabled =
    typeof keyOrOptions === 'object' && keyOrOptions !== null
      ? (keyOrOptions.keepDataWhileDisabled ?? false)
      : false

  const sub = new InfiniteSubscriptionImpl<TPage, TItem>(
    spec.id,
    keepPreviousData,
    keepDataWhileDisabled,
    spec.itemsOf,
  )
  let currentEntry: InfiniteClientEntry<TPage, TItem, unknown> | null = null
  let suspended = false

  const effectDispose = effect(() => {
    // See the regular-query variant above: read enabled + key (when enabled)
    // BEFORE the `suspended` early-return so the effect keeps its deps through
    // suspension; otherwise a key change during suspend empties them and the
    // subscription goes inert after resume (T2.1).
    const isEnabled = enabledFn ? enabledFn() : true
    const args = isEnabled ? ((keyFn ? keyFn() : ([] as unknown as Args)) as Args) : undefined

    if (suspended) return

    if (!isEnabled) {
      untracked(() => {
        sub.setEnabled(false)
        if (currentEntry) {
          currentEntry.release(subscriberPath)
          currentEntry = null
        }
        sub.disable()
      })
      return
    }

    untracked(() => {
      sub.setEnabled(true)
      const entry = client.bindInfiniteEntry<Args, TPage, TItem>(query, args as Args)
      if (currentEntry === entry) return
      if (currentEntry) currentEntry.release(subscriberPath)
      entry.acquire(subscriberPath)
      currentEntry = entry
      sub.attach(entry)

      const status = entry.entry.status.peek()
      const fetching = entry.entry.isFetching.peek()
      if (!fetching && (status === 'idle' || entry.entry.isStaleNow() || status === 'error')) {
        entry.entry.startFetch().catch(() => {
          /* error captured on entry */
        })
      }
    })
  })

  const dispose = () => {
    effectDispose()
    if (currentEntry) {
      currentEntry.release(subscriberPath)
      currentEntry = null
    }
    sub.close()
  }

  const suspend = (): void => {
    if (suspended) return
    suspended = true
    if (currentEntry) {
      currentEntry.release(subscriberPath)
      currentEntry = null
    }
  }

  const resume = (): void => {
    if (!suspended) return
    suspended = false
    const isEnabled = enabledFn ? enabledFn() : true
    if (!isEnabled) {
      // See the regular-query variant: settle into the disabled state now.
      sub.setEnabled(false)
      sub.disable()
      return
    }
    sub.setEnabled(true)
    const args = (keyFn ? keyFn() : ([] as unknown as Args)) as Args
    const entry = client.bindInfiniteEntry<Args, TPage, TItem>(query, args)
    entry.acquire(subscriberPath)
    currentEntry = entry
    sub.attach(entry)
    // Join a fetch in flight, as the regular-query variant does.
    const status = entry.entry.status.peek()
    const fetching = entry.entry.isFetching.peek()
    if (!fetching && (status === 'idle' || entry.entry.isStaleNow() || status === 'error')) {
      entry.entry.startFetch().catch(() => {
        /* error captured on entry */
      })
    }
  }

  return { subscription: sub, dispose, suspend, resume }
}
