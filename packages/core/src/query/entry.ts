import { scheduleExpiry } from '../expiry-timer'
import { batch, type Signal, signal } from '../signals'
import { abortableSleep, isAbortError } from '../utils'
import { subscribeReconnect } from './focus-online'
import { structuralShare } from './structural-share'
import type { AsyncStatus, NetworkMode, RetryDelay, RetryPolicy, Snapshot } from './types'

export type EntryEvents = {
  /**
   * A fetch began. `fetchId` correlates this with its settle + `cache:set-data`.
   */
  onFetchStart?: (fetchId: string) => void
  /**
   * A fetch resolved. Carries the written `data` (so the client can emit a
   * `cache:set-data` for the devtools inspector/timeline) and the `fetchId`
   * shared with the matching `onFetchStart`.
   */
  onFetchSuccess?: (durationMs: number, data: unknown, fetchId: string) => void
  onFetchError?: (durationMs: number, error: unknown, fetchId: string) => void
  /**
   * An optimistic snapshot layer was pushed (`setData` with tracking).
   */
  onSnapshotPush?: () => void
  /**
   * An optimistic snapshot layer was rolled back.
   */
  onSnapshotRollback?: () => void
  /**
   * An optimistic snapshot layer was committed.
   */
  onSnapshotFinalize?: () => void
}

/**
 * Process-wide monotonic counter behind each fetch's `causeId`. A per-`Entry`
 * counter would collide across entries (entry A's fetch #1 vs entry B's #1),
 * wrongly grouping unrelated fetches in the devtools timeline — so it's global.
 */
let globalFetchSeq = 0

/** The next fetch's `causeId`. Shared by `Entry` and `InfiniteEntry`. */
export function nextFetchCauseId(): string {
  return `fetch:${++globalFetchSeq}`
}

export type EntryOptions<T> = {
  /**
   * Called once per attempt; `attempt` is 0, then one more per retry.
   */
  fetcher: () => (signal: AbortSignal, attempt: number) => Promise<T>
  staleTime?: number
  initialData?: T | undefined
  initialUpdatedAt?: number | undefined
  retry?: RetryPolicy
  retryDelay?: RetryDelay
  networkMode?: NetworkMode
  structuralShare?: boolean
  events?: EntryEvents
  /**
   * Fired after a successful fetch result is written to `data` — and only
   * then; hydration is reported by the client itself. Used by the
   * `QueryClient` to report a `'fetch'` write to plugins (devtools events live
   * on `events` above).
   *
   * Privileged closure, set up by `ClientEntry`. The plugin set isolates each
   * hook and routes a throw to `onError` as `kind: 'plugin'`, so nothing is
   * wrapped here: an exception escaping this callback is a bug in core and
   * SHOULD surface.
   */
  onSuccessData?: (data: T) => void
  /**
   * Whether anyone holds the entry: a subscription, or a prefetch in flight.
   * Data that lands while an invalidation still stands makes a held entry
   * fetch once more to reconcile it (§5.7), and so does a `replace` that
   * discards an invalidation's fetch (`supersedeByWrite`). Defaults to nobody.
   */
  hasSubscribers?: () => boolean
}

type SnapshotRecord<T> = {
  id: number
  prev: T | undefined
  live: boolean
}

/**
 * What the entry knew about its latest failed fetch, for the `ErrorContext` the
 * client dispatches (`attempt`, `cause`). Shared by `Entry` and `InfiniteEntry`.
 */
export type FetchFailure = {
  readonly error: unknown
  /**
   * The 0-based attempt that failed last: `0` when no retry ran.
   */
  readonly attempt: number
  /**
   * Present when a `retry` or `retryDelay` callback threw: `error` is then the
   * callback's throw, and `cause` is the fetch error it was deciding on.
   */
  readonly cause?: unknown
}

/**
 * A promise that settles with `request`, or, once `redirects` hands it a
 * catch-up for `request`, with the catch-up instead. Backs `invalidate()` on
 * `Entry` and `InfiniteEntry`.
 */
export function followRedirects<R>(
  request: Promise<R>,
  redirects: WeakMap<Promise<R>, (catchUp: Promise<R>) => void>,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let current = request
    const settleWith = (p: Promise<R>): void => {
      current = p
      p.then(
        (value) => {
          if (current === p) resolve(value)
        },
        (err: unknown) => {
          if (current === p) reject(err)
        },
      )
    }
    redirects.set(request, settleWith)
    settleWith(request)
  })
}

/**
 * A payload timestamp, with one from the future read as now. A server clock
 * ahead of the client's would otherwise give the data a negative age: `isStale`
 * and the subscribe-time check disagree, and freshness outlasts `staleTime`
 * (§15). Shared by `Entry` and `InfiniteEntry`.
 */
export function notInFuture(at: number): number
export function notInFuture(at: number | undefined): number | undefined
export function notInFuture(at: number | undefined): number | undefined {
  return at === undefined ? undefined : Math.min(at, Date.now())
}

/** The `ErrorContext` fields a failure contributes, when `err` is that failure. */
export function failureContext(
  failure: FetchFailure | null,
  err: unknown,
): { attempt: number; cause?: unknown } | undefined {
  if (failure === null || !Object.is(failure.error, err)) return undefined
  return 'cause' in failure
    ? { attempt: failure.attempt, cause: failure.cause }
    : { attempt: failure.attempt }
}

/**
 * One cache entry's state machine. Owns the AsyncState signals, race
 * protection, retry loop, optimistic-update snapshot stack.
 *
 * Internal — not exported from the public surface.
 */
export class Entry<T> {
  readonly data: Signal<T | undefined>
  readonly error: Signal<unknown | undefined> = signal(undefined)
  readonly status: Signal<AsyncStatus>
  readonly isLoading: Signal<boolean> = signal(false)
  readonly isFetching: Signal<boolean> = signal(false)
  readonly lastUpdatedAt: Signal<number | undefined>
  readonly hasPendingMutations: Signal<boolean> = signal(false)
  readonly isStale: Signal<boolean> = signal(true)
  /** True while a fetch is parked waiting for reconnect (online-mode defer or
   *  offlineFirst network-error park). See spec §5.5, T3.5. */
  readonly isPaused: Signal<boolean> = signal(false)

  fetcherProvider: () => (signal: AbortSignal, attempt: number) => Promise<T>
  private staleTime: number
  private retry: RetryPolicy
  private retryDelay: RetryDelay | undefined
  private networkMode: NetworkMode
  private structuralShareEnabled: boolean
  private currentFetchId = 0
  private currentAbort: AbortController | null = null
  /** The request in flight, while one is. */
  private currentRequest: Promise<T> | null = null
  /** `currentFetchId` of the catch-up request; `0` when none has run. */
  private catchUpFetchId = 0
  /**
   * `invalidate()` promises waiting on a request, by that request. When a
   * canonical write discards the request and starts a catch-up, the promise
   * switches to the catch-up at once: it settles with the fetch that
   * reconciled, without waiting for the discarded fetcher to notice its abort.
   */
  // Keyed at `unknown` to keep `Entry<T>` covariant in `T`, as `onSuccessData`.
  private readonly redirects = new WeakMap<Promise<unknown>, (catchUp: Promise<unknown>) => void>()
  /** The latest failed fetch. Read by the client when it reports the failure. */
  private lastFailure: FetchFailure | null = null
  private staleTimer: (() => void) | null = null
  /** Set by `markStale()` (invalidate without fetch); forces `isStaleNow()`
   *  true until data requested after it lands. Spec §5.7, T3.9. */
  private forcedStale = false
  /**
   * Bumped by every `markStale()`. A fetch records it at start, and its success
   * clears `forcedStale` only when no `markStale()` came after: a response
   * requested before an invalidation does not reconcile it (§5.7).
   */
  private staleEpoch = 0
  /** `Date.now()` of the latest `markStale()`. A hydrated row clears
   *  `forcedStale` only when it is stamped at or after this. */
  private staleSince = 0
  /**
   * When the server truth the entry holds was written: by a fetch, a hydrated
   * row or a canonical write. Unlike `lastUpdatedAt`, an optimistic `setData`
   * leaves it alone. Staleness is measured from it (§5.9), and a hydrated row
   * is compared against it (§15), so a guess never counts as server data.
   */
  private serverUpdatedAt: number | undefined
  /**
   * Set when `isStaleNow()` answered "no" only because an optimistic write was
   * live: a subscriber, a focus or reconnect trigger, or a prefetch wanted a
   * fetch and did not start one. The entry runs it once the last live write
   * settles (`runHeldBackFetch`). Any fetch that starts clears it.
   */
  private fetchHeldBack = false
  private readonly hasSubscribers: () => boolean
  private snapshots: Array<SnapshotRecord<T>> = []
  private nextSnapshotId = 0
  private disposed = false
  /** Subscribers to reconnect — installed lazily when a deferred fetch lands. */
  private reconnectUnsub: (() => void) | null = null
  /**
   * Set of deferred-fetch resolvers waiting for reconnect (online mode).
   * Stored at `unknown` to keep `Entry<T>` covariant in `T` — same trick as
   * `onSuccessData`. Each resolver is fed the same value from
   * `applySuccess`, which is `T`, then cast at the fan-out call site.
   */
  private deferredResolvers: Array<{
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }> = []
  private readonly events: EntryEvents
  // Stored at `unknown` (not `T`) to keep `Entry<T>` covariant in `T`. The
  // callback only forwards the value through; Entry never inspects it.
  private readonly onSuccessData: ((data: unknown) => void) | undefined
  private fetchStartTime = 0
  /** `causeId` of the in-flight fetch — shared across its start + settle events. */
  private currentFetchCauseId = ''
  /**
   * Promises returned by `firstValue()` that haven't settled. Rejected on
   * `dispose()` so awaiters (most notably `prefetch` and `subscription.firstValue`)
   * don't hang when the controller tree is torn down mid-fetch.
   */
  private pendingFirstValueRejects: Array<(err: unknown) => void> = []

  constructor(options: EntryOptions<T>) {
    this.fetcherProvider = options.fetcher
    this.staleTime = options.staleTime ?? 0
    this.retry = options.retry ?? 0
    // Left undefined when not given so `computeDelay` can pick the exponential
    // default only when retries are actually enabled (T3.9).
    this.retryDelay = options.retryDelay
    this.networkMode = options.networkMode ?? 'online'
    this.structuralShareEnabled = options.structuralShare ?? true
    this.events = options.events ?? {}
    this.onSuccessData = options.onSuccessData as ((data: unknown) => void) | undefined
    this.hasSubscribers = options.hasSubscribers ?? (() => false)
    this.data = signal<T | undefined>(options.initialData)
    const initialUpdatedAt = notInFuture(options.initialUpdatedAt)
    this.serverUpdatedAt = initialUpdatedAt
    if (options.initialData !== undefined) {
      this.status = signal<AsyncStatus>('success')
      // For hydrated data, derive `isStale` from the *actual* age of the
      // payload, not the timer alone — otherwise a payload older than
      // `staleTime` would read `isStale === false` until the (fresh, full-
      // length) timer fires, and disagree with `isStaleNow()`.
      this.settleStaleness(initialUpdatedAt)
    } else {
      this.status = signal<AsyncStatus>('idle')
    }
    this.lastUpdatedAt = signal<number | undefined>(initialUpdatedAt)
  }

  startFetch(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Entry disposed'))
    }
    // This fetch, or the parked one below, brings what a held-back fetch wanted.
    this.fetchHeldBack = false
    // `online` mode: defer until reconnect when the browser thinks we're
    // offline. The UI keeps showing last-known data. `always` / `offlineFirst`
    // proceed to the fetcher; `offlineFirst` will re-handle a network
    // rejection inside the catch path.
    //
    // A fetch already in flight is superseded first, as a request made online
    // supersedes it (§5.5): its response was asked for before this request,
    // and on a local cache whose key changed it carries the old key's data.
    // One batch, so no observer sees the entry settled and unpaused between.
    if (this.networkMode === 'online' && this.isOffline()) {
      let parked: Promise<T> | undefined
      batch(() => {
        this.cancel()
        parked = this.scheduleDeferredFetch()
      })
      return parked as Promise<T>
    }
    const myId = ++this.currentFetchId
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort

    const previouslyHadData = this.data.peek() !== undefined
    batch(() => {
      this.status.set('pending')
      this.isFetching.set(true)
      this.isLoading.set(!previouslyHadData)
      this.isPaused.set(false)
    })

    this.fetchStartTime = Date.now()
    this.currentFetchCauseId = nextFetchCauseId()
    try {
      this.events.onFetchStart?.(this.currentFetchCauseId)
    } catch {
      // devtools handlers must not break the program.
    }

    const request = this.runWithRetry(myId, abort, this.staleEpoch)
    this.currentRequest = request
    return this.releaseOnSettle(request, abort)
  }

  /**
   * Forget `abort` once the request it belongs to settles. A finished request
   * has nothing to cancel, and `abort()` on its controller still builds a
   * `DOMException`: kept as `currentAbort`, it made every refetch, hydration
   * and dispose pay for one.
   */
  private releaseOnSettle(work: Promise<T>, abort: AbortController): Promise<T> {
    const release = (): void => {
      if (this.currentAbort === abort) this.currentAbort = null
      if (this.currentRequest === work) this.currentRequest = null
    }
    work.then(release, release)
    return work
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  }

  private scheduleDeferredFetch(): Promise<T> {
    // Parked waiting for reconnect — surface it so the UI can show "waiting
    // for network" instead of a silent `idle` (T3.5). Cleared when the fetch
    // actually starts (`startFetch` batch) or settles.
    this.isPaused.set(true)
    // Lazy-install one reconnect listener for the entry. Cleared on dispose
    // and on the first successful drain. Each call appends a fresh resolver.
    if (this.reconnectUnsub === null) {
      this.reconnectUnsub = subscribeReconnect(() => this.drainDeferred())
    }
    return new Promise<T>((resolve, reject) => {
      this.deferredResolvers.push({
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
  }

  /**
   * Run a parked fetch now, if the network is back. The reconnect drain runs
   * only on an `online` event, and that event never comes without a `window`
   * (a worker), or can come while `navigator.onLine` still reads false. The
   * interval, focus and reconnect triggers call this instead of starting a
   * fetch of their own, so one request still settles every parked waiter
   * (§5.9). A no-op while offline or with nothing parked.
   */
  resumeParked(): void {
    if (!this.isOffline()) this.drainDeferred()
  }

  private drainDeferred(): void {
    if (this.deferredResolvers.length === 0) return
    if (this.disposed) return
    const pending = this.deferredResolvers
    this.deferredResolvers = []
    // One real fetch fans out to every pending resolver. Tearing down the
    // reconnect listener avoids accumulating listeners across many deferrals.
    if (this.reconnectUnsub !== null) {
      this.reconnectUnsub()
      this.reconnectUnsub = null
    }
    this.startFetch().then(
      (value) => {
        for (const p of pending) p.resolve(value)
      },
      (err) => {
        for (const p of pending) p.reject(err)
      },
    )
  }

  private async runWithRetry(myId: number, abort: AbortController, staleEpoch: number): Promise<T> {
    let attempt = 0
    while (true) {
      if (myId !== this.currentFetchId || this.disposed) {
        throw new DOMException('Superseded', 'AbortError')
      }
      try {
        const fetcher = this.fetcherProvider()
        const result = await fetcher(abort.signal, attempt)
        if (myId !== this.currentFetchId || this.disposed) {
          throw new DOMException('Superseded', 'AbortError')
        }
        return this.applySuccess(result, staleEpoch)
      } catch (err) {
        // Superseded or disposed: a newer fetch (or `cancel` / `applyHydration`
        // / `dispose`) owns the entry's state now and has already set it, so
        // this one must write nothing — §5.6, "errors from outdated fetches are
        // also dropped". Its caller hears the supersede, not the stale error,
        // exactly as when the outdated request succeeds: an `invalidate()` would
        // otherwise report it to `onError`, and a `prefetch()` would reject.
        if (myId !== this.currentFetchId || this.disposed) {
          throw new DOMException('Superseded', 'AbortError')
        }
        if (isAbortError(err)) {
          // Still the latest fetch, yet the request aborted. Nothing in the
          // engine did it — every engine-side abort bumps `currentFetchId` or
          // sets `disposed` first, both caught above — so it came from the
          // fetcher itself: its own timeout signal, an axios cancel token, a
          // rethrown stale abort. No newer request is coming to settle the
          // entry, and leaving `isFetching` true wedges the spinner forever and
          // hangs `waitForIdle()` (SSR) and `firstValue()` (Suspense) with it.
          // So it settles like any other failure — the retry policy stays out
          // of it, as it is for every abort.
          return this.applyFailure(err, attempt)
        }
        // offlineFirst: a network-shaped failure while offline parks the entry
        // (wait for reconnect, then retry) instead of surfacing the error. A
        // `fetch()` network failure surfaces as a `TypeError`; `AbortError` is
        // already handled above. Spec §5.5, T3.5.
        if (this.networkMode === 'offlineFirst' && this.isOffline() && err instanceof TypeError) {
          // One batch with the park, so no observer sees the entry settled and
          // unpaused in between (`settled()` would take that for a cancel).
          let parked: Promise<T> | undefined
          batch(() => {
            this.isFetching.set(false)
            this.isLoading.set(false)
            this.status.set(this.data.peek() !== undefined ? 'success' : 'idle')
            parked = this.scheduleDeferredFetch()
          })
          return parked as Promise<T>
        }
        let delay: number | null
        try {
          delay = this.shouldRetry(attempt, err) ? this.computeDelay(attempt) : null
        } catch (policyErr) {
          // A `retry` or `retryDelay` callback threw. That fails this attempt
          // with the callback's error: escaping the loop instead would reject
          // the fetch with `isFetching` still true, and nothing would come to
          // clear it. The fetch error it was deciding on travels as the
          // failure's `cause`.
          return this.applyFailure(policyErr, attempt, err)
        }
        if (delay === null) return this.applyFailure(err, attempt)
        await abortableSleep(delay, abort.signal)
        attempt += 1
      }
    }
  }

  private shouldRetry(attempt: number, err: unknown): boolean {
    const retry = this.retry
    if (retry === false || retry === 0) return false
    if (typeof retry === 'number') return attempt < retry
    return retry(attempt, err)
  }

  private computeDelay(attempt: number): number {
    const d = this.retryDelay
    // Default to exponential backoff (capped at 30s) when `retry > 0` but no
    // `retryDelay` was given — a constant 1s default hammered a flapping
    // backend on every attempt (T3.9). Explicit number/function still wins.
    if (d === undefined) return Math.min(1000 * 2 ** attempt, 30_000)
    return typeof d === 'function' ? d(attempt) : d
  }

  /**
   * Write a fetch result. `staleEpoch` is the `staleEpoch` the fetch started
   * under: a `markStale()` since then keeps the entry stale.
   */
  private applySuccess(result: T, staleEpoch: number): T {
    // Structurally share with the previous value so unchanged sub-trees
    // keep their `===` identity. Downstream `computed`s and React snapshots
    // stop thrashing on no-op refetches. Bails on Maps/Sets/class instances
    // — see `structural-share.ts`. Disabled per-query via `structuralShare:
    // false` for large payloads where the O(payload) walk costs more than
    // the re-render savings.
    const prev = this.data.peek() as T | undefined
    const shared =
      prev === undefined || !this.structuralShareEnabled ? result : structuralShare(prev, result)
    // Rebase live optimistic snapshots onto the fresh server truth: a
    // subsequent rollback should restore to THIS value, not the pre-fetch
    // baseline the snapshot captured before the fetch resolved. Without this,
    // a fetch landing during an optimistic mutation, then that mutation
    // failing, resurrects pre-fetch data (spec §6.4, T3.4).
    if (this.snapshots.length > 0) {
      for (const s of this.snapshots) s.prev = shared
    }
    // Data requested after the latest `markStale()` reconciles it (T3.9). A
    // response requested before it does not: the invalidation asked for data
    // newer than this, so the entry stays stale, and a held entry catches up
    // below (§5.7).
    if (staleEpoch === this.staleEpoch) this.forcedStale = false
    const landed = this.currentRequest
    batch(() => {
      const now = Date.now()
      this.data.set(shared)
      this.error.set(undefined)
      this.status.set('success')
      this.isLoading.set(false)
      this.isFetching.set(false)
      this.lastUpdatedAt.set(now)
      this.serverUpdatedAt = now
      this.settleStaleness(now)
      // Announced before any catch-up starts, while `currentFetchCauseId` is
      // still this fetch's.
      try {
        this.events.onFetchSuccess?.(now - this.fetchStartTime, shared, this.currentFetchCauseId)
      } catch {
        // devtools handlers must not break the program.
      }
      this.catchUpIfStillStale(landed)
    })
    this.onSuccessData?.(shared)
    return shared
  }

  /**
   * Data just landed that leaves an invalidation standing: a response
   * requested before it, or a hydrated row stamped before it. A subscriber
   * that joined the older fetch, or a prefetch holding the entry, is already
   * here and will not trigger the refetch the invalidation asks for (§5.7). So
   * a held entry fetches once more. Called inside the batch that wrote the
   * data, so `isFetching` never reads `false` in between.
   *
   * `landed` is the request that delivered or was discarded by the data; an
   * `invalidate()` waiting on it follows the catch-up.
   */
  private catchUpIfStillStale(landed: Promise<unknown> | null): void {
    if (this.forcedStale && this.hasSubscribers()) this.startCatchUp(landed)
  }

  /**
   * Start the fetch an invalidation is still waiting for. A `replace` does not
   * supersede it (`supersedeByWrite`), and an `invalidate()` waiting on
   * `replaced` settles with it instead.
   */
  private startCatchUp(replaced: Promise<unknown> | null): void {
    const request = this.startFetch()
    this.catchUpFetchId = this.currentFetchId
    // The outcome settles on the entry.
    request.catch(() => {})
    if (replaced !== null) this.redirects.get(replaced)?.(request)
  }

  /**
   * Settle the fetch as failed with `err`. `cause` is passed, as a third
   * argument, only when `err` replaced the fetch's own error: a throwing
   * `retry` / `retryDelay` callback.
   */
  private applyFailure(err: unknown, attempt: number, ...cause: [] | [unknown]): never {
    batch(() => {
      this.error.set(err)
      this.status.set('error')
      this.isLoading.set(false)
      this.isFetching.set(false)
    })
    this.lastFailure =
      cause.length === 0 ? { error: err, attempt } : { error: err, attempt, cause: cause[0] }
    try {
      this.events.onFetchError?.(Date.now() - this.fetchStartTime, err, this.currentFetchCauseId)
    } catch {
      // devtools handlers must not break the program.
    }
    throw err
  }

  /**
   * Set `isStale` from the age of server truth written at `at`, and arm the
   * timer for the rest of `staleTime`. Every write of server truth calls it:
   * a fetch, a hydrated row, a canonical write. An optimistic write does not,
   * so the signal and `isStaleNow()` follow one clock (§5.9).
   */
  private settleStaleness(at: number | undefined): void {
    if (this.staleTimer !== null) {
      this.staleTimer()
      this.staleTimer = null
    }
    const age = at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at
    const alreadyStale = this.forcedStale || this.staleTime === 0 || age >= this.staleTime
    this.isStale.set(alreadyStale)
    if (!alreadyStale) {
      this.staleTimer = scheduleExpiry(this.staleTime - age, () => {
        this.staleTimer = null
        if (!this.disposed) this.isStale.set(true)
      })
    }
  }

  refetch(): Promise<T> {
    return this.startFetch()
  }

  /**
   * Apply a server-supplied data + timestamp without going through the
   * fetcher path. Used by streaming SSR hydration: each `<Suspense>` boundary
   * that resolves on the server pushes its entry's data to the client, and
   * the client routes it through here so the entry transitions to `success`
   * without burning the user's fetcher.
   *
   * Distinct from `setData`: no Snapshot returned (no rollback semantics —
   * this is canonical data, not an optimistic patch), no
   * `hasPendingMutations` flip, and `lastUpdatedAt` honors the supplied
   * server timestamp instead of `Date.now()`. Also bumps `currentFetchId`
   * so any in-flight fetch supersedes itself rather than overwriting the
   * fresher hydrated value.
   *
   * A row stamped before the server truth the entry holds is older than it,
   * so it is skipped and nothing changes. An optimistic write does not count:
   * it is a guess, and the row is folded under it as a fetch would be (§6.4).
   * Returns whether the row was written; the client reports a `'hydrate'`
   * write only then.
   *
   * A row stamped before the latest invalidation leaves it standing, and a
   * held entry then fetches once more (`catchUpIfStillStale`): the row also
   * discarded the fetch that invalidation started.
   */
  applyHydration(data: T, serverUpdatedAt: number): boolean {
    if (this.disposed) return false
    const lastUpdatedAt = notInFuture(serverUpdatedAt)
    const current = this.serverUpdatedAt
    if (current !== undefined && lastUpdatedAt < current) return false
    const discarded = this.currentRequest
    // Bump fetch id: an inflight fetcher will now lose the supersede check
    // in `runWithRetry` and won't write its (likely-stale) result.
    this.currentFetchId += 1
    this.currentAbort?.abort()
    this.currentAbort = null
    // A row stamped at or after the latest `markStale()` reconciles it, as a
    // fetch requested after it does (§5.7). An older row does not.
    if (lastUpdatedAt >= this.staleSince) this.forcedStale = false
    // Hydrated data is server truth, like a fetch result: rebase live
    // optimistic snapshots onto it, so a later rollback restores it rather
    // than a baseline from before it arrived (spec §6.4, as in `applySuccess`).
    for (const s of this.snapshots) s.prev = data
    batch(() => {
      this.data.set(data)
      this.error.set(undefined)
      this.status.set('success')
      this.isLoading.set(false)
      this.isFetching.set(false)
      this.lastUpdatedAt.set(lastUpdatedAt)
      this.serverUpdatedAt = lastUpdatedAt
      this.settleStaleness(lastUpdatedAt)
      this.catchUpIfStillStale(discarded)
    })
    // Not `onSuccessData`: that reports a fetch, and this is not one. The
    // client reports the write itself, once, as `'hydrate'`. First-value
    // awaiters subscribe to `status`, which the batch above already woke.
    return true
  }

  /**
   * Force this entry stale WITHOUT fetching. `isStaleNow()` returns true until
   * data requested after this call lands: a fetch started after it, or a
   * hydrated row stamped after it. So the next subscriber refetches. Used by
   * `client.invalidate` for subscriber-less entries — spec §5.7 says
   * invalidate refetches only IF subscribed (T3.9).
   */
  markStale(): void {
    if (this.disposed) return
    if (this.staleTimer != null) {
      this.staleTimer()
      this.staleTimer = null
    }
    this.staleEpoch += 1
    this.staleSince = Date.now()
    this.forcedStale = true
    this.isStale.set(true)
  }

  /**
   * Mark stale and refetch. The promise settles with that refetch, or, when a
   * canonical write discarded it and started a catch-up (`supersedeByWrite`),
   * with the catch-up: the fetch that reconciled, not the one thrown away.
   */
  invalidate(): Promise<T> {
    this.markStale()
    return followRedirects<unknown>(this.startFetch(), this.redirects) as Promise<T>
  }

  /** The latest failure's `attempt` and `cause`, when `err` is that failure. */
  failureOf(err: unknown): { attempt: number; cause?: unknown } | undefined {
    return failureContext(this.lastFailure, err)
  }

  reset(): void {
    if (this.disposed) return
    batch(() => {
      this.error.set(undefined)
      this.status.set(this.data.peek() !== undefined ? 'success' : 'idle')
    })
  }

  /**
   * Cancel an in-flight fetch without touching `data`. Aborts the current
   * request and supersedes it (bumps `currentFetchId` so its result can never
   * land), then restores a settled status: `'success'` if data exists, else
   * `'idle'`. No-op when nothing is fetching. This is the primitive behind
   * `query.cancel(...)` / `subscription.cancel()`: the canonical optimistic
   * recipe cancels outgoing refetches before an optimistic `setData` so a
   * stale response can't clobber the optimistic value (spec §5, §6.4). T3.4.
   */
  cancel(): void {
    if (this.disposed || !this.isFetching.peek()) return
    this.currentFetchId += 1
    this.currentAbort?.abort()
    this.currentAbort = null
    batch(() => {
      this.isFetching.set(false)
      this.isLoading.set(false)
      this.status.set(this.data.peek() !== undefined ? 'success' : 'idle')
    })
  }

  /**
   * Supersede the fetch in flight on behalf of a canonical whole-record write
   * (`replace`, §6.4): its response was requested before the record and must
   * not land over it.
   *
   * When the entry is force-stale, the discarded response was the
   * reconciliation an invalidation asked for, and the write carries only its
   * own record. The entry therefore re-fetches once, if the `hasSubscribers`
   * option says someone still holds it. A reconnect's `invalidateAll()`
   * followed by a pushed `replace` is the case: without this, nothing re-runs
   * the catch-up.
   *
   * That catch-up is not superseded by a later write. A burst of pushes then
   * coalesces into the one request instead of cancelling and restarting it on
   * every push, which would never let it land. A write during the catch-up is
   * treated as a patch: the catch-up's response is the server truth the
   * invalidation is waiting for, and it lands over the write.
   */
  supersedeByWrite(): void {
    if (this.disposed || !this.isFetching.peek()) return
    if (this.currentFetchId === this.catchUpFetchId) return
    const discarded = this.currentRequest
    // One batch: `isFetching` never reads false between the cancel and the
    // catch-up, so an awaiter such as `waitForIdle()` cannot resolve early.
    batch(() => {
      this.cancel()
      this.catchUpIfStillStale(discarded)
    })
  }

  /**
   * Write data into the entry.
   *
   * `track` (default `true`) is the optimistic-update path: it pushes a
   * snapshot record and flips `hasPendingMutations`, so the returned
   * `Snapshot.rollback()` can restore the pre-write baseline and
   * `finalize()` commits it. This is what `query.setData(...)` inside a
   * mutation's `onMutate` uses (spec §6.4).
   *
   * `track: false` is a canonical cache write — cross-tab receive, entities
   * backprop, realtime patches (spec §6.4). It updates the data signal but
   * pushes NO snapshot and does NOT flip `hasPendingMutations`, so a
   * fire-and-forget plugin write can't wedge the pending flag at `true`
   * forever. Returns a no-op `Snapshot`.
   */
  setData(updater: (prev: T | undefined) => T, opts?: { track?: boolean }): Snapshot {
    if (this.disposed) {
      return { rollback: () => {}, finalize: () => {} }
    }
    const prev = this.data.peek()
    const next = updater(prev)
    const track = opts?.track ?? true
    const record: SnapshotRecord<T> | null = track
      ? { id: this.nextSnapshotId++, prev, live: true }
      : null
    if (record) this.snapshots.push(record)
    // A CANONICAL write rebases live optimistic snapshots onto itself, exactly as a
    // successful fetch does (`applySuccess`) and for the same stated reason (spec §6.4):
    // a later rollback must restore server truth, not a baseline captured before that
    // truth arrived. Without this, a canonical write landing mid-mutation is silently undone
    // by the mutation's own rollback — and undone to a value older still when the caller was
    // `replace`, which supersedes the in-flight fetch that would otherwise have rebased.
    // Tracked writes are excluded: an optimistic layer is a guess, and rebasing onto a
    // guess is what the baseline exists to protect against.
    if (!track && this.snapshots.length > 0) {
      for (const sn of this.snapshots) sn.prev = next
    }

    batch(() => {
      const now = Date.now()
      this.data.set(next)
      if (this.status.peek() === 'idle' || this.status.peek() === 'pending') {
        this.status.set('success')
      }
      this.lastUpdatedAt.set(now)
      // A canonical write is server truth, so the stale clock restarts from
      // it. An optimistic one is a guess and leaves the clock alone (§5.9).
      if (!track) {
        this.serverUpdatedAt = now
        this.settleStaleness(now)
      }
      if (record) this.hasPendingMutations.set(true)
    })

    if (!record) {
      return { rollback: () => {}, finalize: () => {} }
    }
    try {
      this.events.onSnapshotPush?.()
    } catch {
      // devtools handlers must not break the program.
    }
    const id = record.id
    return {
      rollback: () => {
        if (!record.live || this.disposed) return
        record.live = false
        batch(() => {
          const i = this.snapshots.indexOf(record)
          if (i !== -1) {
            if (i === this.snapshots.length - 1) {
              // Top of the stack: restore this layer's captured baseline as
              // the current data.
              this.data.set(record.prev as T)
            } else {
              // Not the top: leave the currently-displayed value alone and
              // thread this layer's baseline down onto the next layer, so a
              // later top-rollback lands on the correct pre-everything value
              // instead of resurrecting this layer's delta (chain-splice —
              // T3.1, spec §6.4). Out-of-order rollback of all layers now
              // returns to the original pre-mutation value.
              const below = this.snapshots[i + 1] as SnapshotRecord<T>
              below.prev = record.prev
            }
            this.snapshots.splice(i, 1)
          }
          this.hasPendingMutations.set(this.snapshots.some((s) => s.live))
        })
        try {
          this.events.onSnapshotRollback?.()
        } catch {
          // devtools handlers must not break the program.
        }
        this.runHeldBackFetch()
      },
      finalize: () => {
        if (!record.live || this.disposed) return
        record.live = false
        this.snapshots = this.snapshots.filter((s) => s.id !== id)
        if (!this.snapshots.some((s) => s.live)) {
          this.hasPendingMutations.set(false)
        }
        try {
          this.events.onSnapshotFinalize?.()
        } catch {
          // devtools handlers must not break the program.
        }
        this.runHeldBackFetch()
      },
    }
  }

  /**
   * Run the fetch a live optimistic write held back (`isStaleNow`), once the
   * last live write has settled. The decision waits one microtask: a
   * mutation's `onSuccess` or `onSettled` that calls `invalidate()` right
   * after the settle starts its own fetch first, and this one then has nothing
   * to add. It fetches only while someone still holds the entry, nothing is in
   * flight, and the entry is still stale.
   */
  private runHeldBackFetch(): void {
    if (!this.fetchHeldBack || this.snapshots.length > 0) return
    queueMicrotask(() => {
      // A new optimistic write went live meanwhile: its own settle decides.
      if (this.disposed || !this.fetchHeldBack || this.snapshots.length > 0) return
      this.fetchHeldBack = false
      if (!this.hasSubscribers() || this.isFetching.peek()) return
      // A parked fetch runs once the network is back, as the triggers' does.
      if (this.isPaused.peek()) {
        this.resumeParked()
        return
      }
      if (!this.forcedStale && !this.isServerStale()) return
      // The outcome settles on the entry, as a subscribe-time fetch's does.
      this.startFetch().catch(() => {})
    })
  }

  /**
   * Resolves at once when the entry holds data (`!== undefined`, §6.4), even
   * while a background refetch runs or after one failed. Otherwise it waits for
   * the first success, and rejects on the first failure or on dispose.
   */
  firstValue(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new DOMException('Entry disposed', 'AbortError'))
    }
    const data = this.data.peek()
    if (data !== undefined || this.status.peek() === 'success') {
      return Promise.resolve(data as T)
    }
    if (this.status.peek() === 'error') {
      return Promise.reject(this.error.peek())
    }
    return new Promise<T>((resolve, reject) => {
      const tracked = (err: unknown): void => {
        this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
        reject(err)
      }
      this.pendingFirstValueRejects.push(tracked)
      const unsub = this.status.subscribe((s) => {
        if (s === 'success') {
          unsub()
          this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
          resolve(this.data.peek() as T)
        } else if (s === 'error') {
          unsub()
          tracked(this.error.peek())
        }
      })
    })
  }

  /**
   * Settle with the fetch in flight, or with whatever takes it over: resolves
   * with the data once the entry lands at `success`, rejects with the error at
   * `error`. A newer fetch that supersedes it keeps the wait going, and so does
   * a fetch parked for the network. A `cancel()` that leaves the entry without
   * data rejects with an `AbortError`, since no fetch is coming to fill it.
   * Called with nothing in flight, it settles with what the entry holds.
   *
   * Backs `prefetch`, which must neither resolve with the stale data a refetch
   * is replacing (as `firstValue()` would) nor wait forever on a cancelled fetch.
   */
  settled(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new DOMException('Entry disposed', 'AbortError'))
    }
    const now = this.settledOutcome()
    if (now !== null) return now
    return new Promise<T>((resolve, reject) => {
      const tracked = (err: unknown): void => {
        stop()
        reject(err)
      }
      const stop = (): void => {
        offFetching()
        offPaused()
        this.pendingFirstValueRejects = this.pendingFirstValueRejects.filter((f) => f !== tracked)
      }
      const check = (): void => {
        const outcome = this.settledOutcome()
        if (outcome === null) return
        stop()
        outcome.then(resolve, reject)
      }
      this.pendingFirstValueRejects.push(tracked)
      const offFetching = this.isFetching.subscribeChanges(check)
      const offPaused = this.isPaused.subscribeChanges(check)
    })
  }

  /** What `settled()` settles with now, or `null` while a fetch is in flight or parked. */
  private settledOutcome(): Promise<T> | null {
    if (this.isFetching.peek() || this.isPaused.peek()) return null
    const status = this.status.peek()
    if (status === 'success') return Promise.resolve(this.data.peek() as T)
    if (status === 'error') return Promise.reject(this.error.peek())
    return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  }

  /**
   * Whether a subscriber, a focus or reconnect trigger, or a prefetch should
   * fetch now. An invalidation still standing says yes (§5.7). Otherwise the
   * answer follows the server's clock: yes when the entry holds no server data,
   * or when its last fetch, hydrated row or canonical write is `staleTime` old.
   * An optimistic write does not reset that clock (§5.9).
   *
   * While an optimistic write is live the answer is no, because the response
   * would land over the guess on screen (§6.4). The entry records the request
   * and runs it once the last live write settles (`runHeldBackFetch`).
   */
  isStaleNow(): boolean {
    if (this.forcedStale) return true
    if (!this.isServerStale()) return false
    if (this.snapshots.length > 0) {
      this.fetchHeldBack = true
      return false
    }
    return true
  }

  /** Whether the server truth is `staleTime` old, or the entry holds none. */
  private isServerStale(): boolean {
    const at = this.serverUpdatedAt
    return at === undefined || Date.now() - at >= this.staleTime
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.staleTimer != null) {
      this.staleTimer()
      this.staleTimer = null
    }
    this.currentAbort?.abort()
    this.currentAbort = null
    // A disposed entry is idle. Reset the in-flight flags so `waitForIdle`
    // (which waits on `isFetching`) can't hang when a fetch races dispose — the
    // aborted fetcher's applySuccess/applyFailure never runs to clear them (T3.9).
    batch(() => {
      this.isFetching.set(false)
      this.isLoading.set(false)
    })
    if (this.reconnectUnsub !== null) {
      this.reconnectUnsub()
      this.reconnectUnsub = null
    }
    if (this.deferredResolvers.length > 0) {
      const disposed = new DOMException('Entry disposed', 'AbortError')
      const pending = this.deferredResolvers
      this.deferredResolvers = []
      for (const p of pending) p.reject(disposed)
    }
    if (this.pendingFirstValueRejects.length > 0) {
      const disposed = new DOMException('Entry disposed', 'AbortError')
      const rejects = this.pendingFirstValueRejects
      this.pendingFirstValueRejects = []
      for (const fn of rejects) fn(disposed)
    }
  }
}
