import { computed, effect, type Signal, signal, untracked } from '../signals'
import type { ReadSignal } from '../signals/types'
import type { ClientEntry, InfiniteClientEntry, QueryClient } from './client'
import type { InfiniteQuery, InfiniteQuerySpec, InfiniteQuerySubscription } from './infinite'
import type { AsyncStatus, Query, QuerySpec, QuerySubscription, UseOptions } from './types'

type QueryInternal<Args extends unknown[], T> = Query<Args, T> & {
  readonly __spec: QuerySpec<Args, T>
}

class SubscriptionImpl<T> implements QuerySubscription<T> {
  private readonly current$: Signal<ClientEntry<T> | null> = signal(null)
  private readonly previousData$: Signal<T | undefined> = signal(undefined)

  readonly data: ReadSignal<T | undefined>
  readonly error: ReadSignal<unknown | undefined>
  readonly status: ReadSignal<AsyncStatus>
  readonly isLoading: ReadSignal<boolean>
  readonly isFetching: ReadSignal<boolean>
  readonly isStale: ReadSignal<boolean>
  readonly lastUpdatedAt: ReadSignal<number | undefined>
  readonly hasPendingMutations: ReadSignal<boolean>

  constructor(private readonly keepPreviousData: boolean) {
    this.data = computed(() => {
      const cur = this.current$.value
      const curData = cur?.entry.data.value
      if (curData !== undefined) return curData
      if (keepPreviousData) return this.previousData$.value
      return undefined
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
  }

  attach(entry: ClientEntry<T>): void {
    const prev = this.current$.peek()
    if (prev === entry) return
    if (prev && this.keepPreviousData) {
      const prevData = prev.entry.data.peek()
      if (prevData !== undefined) this.previousData$.set(prevData)
    }
    this.current$.set(entry)
  }

  detach(): void {
    this.current$.set(null)
  }

  refetch = (): Promise<T> => {
    const cur = this.current$.peek()
    if (!cur) return Promise.reject(new Error('[olas] no active subscription'))
    return cur.entry.refetch()
  }

  reset = (): void => {
    this.current$.peek()?.entry.reset()
  }

  firstValue = (): Promise<T> => {
    const cur = this.current$.peek()
    if (!cur) return Promise.reject(new Error('[olas] no active subscription'))
    return cur.entry.firstValue()
  }
}

/**
 * Build a subscription + the effect that keeps it bound to the right entry.
 * The controller container wires the disposer into the lifecycle.
 */
export function createUse<Args extends unknown[], T>(
  client: QueryClient,
  query: Query<Args, T>,
  keyOrOptions?: (() => Args) | UseOptions<Args>,
): {
  subscription: QuerySubscription<T>
  dispose: () => void
  /** Suspend the subscription — release the entry (its refetchInterval +
   *  focus/online listeners pause) without disposing it. Spec §4.1. */
  suspend: () => void
  /** Resume after `suspend`. Re-acquires the entry and refetches if stale. */
  resume: () => void
} {
  const internal = query as unknown as QueryInternal<Args, T>
  const spec = internal.__spec
  const keepPreviousData = spec.keepPreviousData ?? false

  const keyFn = typeof keyOrOptions === 'function' ? keyOrOptions : keyOrOptions?.key
  const enabledFn =
    typeof keyOrOptions === 'object' && keyOrOptions !== null ? keyOrOptions.enabled : undefined

  const sub = new SubscriptionImpl<T>(keepPreviousData)
  let currentEntry: ClientEntry<T> | null = null
  let suspended = false

  const effectDispose = effect(() => {
    if (suspended) return
    const isEnabled = enabledFn ? enabledFn() : true
    if (!isEnabled) {
      untracked(() => {
        if (currentEntry) {
          currentEntry.release()
          currentEntry = null
        }
        sub.detach()
      })
      return
    }

    const args = (keyFn ? keyFn() : ([] as unknown as Args)) as Args

    untracked(() => {
      const entry = client.bindEntry<Args, T>(query, args)
      if (currentEntry === entry) return
      if (currentEntry) currentEntry.release()
      entry.acquire()
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
      currentEntry.release()
      currentEntry = null
    }
    sub.detach()
  }

  const suspend = (): void => {
    if (suspended) return
    suspended = true
    if (currentEntry) {
      currentEntry.release()
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
    if (!isEnabled) return
    const args = (keyFn ? keyFn() : ([] as unknown as Args)) as Args
    const entry = client.bindEntry<Args, T>(query, args)
    entry.acquire()
    currentEntry = entry
    sub.attach(entry)
    // On resume, refetch if stale (matches the spec §4.1 "stale-on-resume"
    // requirement). Non-stale data stays as-is.
    const status = entry.entry.status.peek()
    if (status === 'idle' || entry.entry.isStaleNow() || status === 'error') {
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
  readonly hasNextPage: ReadSignal<boolean>
  readonly hasPreviousPage: ReadSignal<boolean>
  readonly isFetchingNextPage: ReadSignal<boolean>
  readonly isFetchingPreviousPage: ReadSignal<boolean>

  constructor(private readonly keepPreviousData: boolean) {
    this.pages = computed(() => {
      const cur = this.current$.value
      const ps = cur?.entry.pages.value
      if (ps && ps.length > 0) return ps
      if (keepPreviousData) return this.previousPages$.value ?? []
      return ps ?? []
    })
    this.data = computed(() => {
      const cur = this.current$.value
      const ps = cur?.entry.pages.value
      if (ps && ps.length > 0) return ps
      if (keepPreviousData) {
        const prev = this.previousPages$.value
        if (prev && prev.length > 0) return prev
      }
      return undefined
    })
    this.flat = computed(() => this.current$.value?.entry.flat.value ?? [])
    this.error = computed(() => this.current$.value?.entry.error.value)
    this.status = computed<AsyncStatus>(() => this.current$.value?.entry.status.value ?? 'idle')
    this.isLoading = computed(() => {
      const cur = this.current$.value
      if (!cur) return false
      if (keepPreviousData) {
        const prev = this.previousPages$.value
        if (prev && prev.length > 0) return false
      }
      return cur.entry.isLoading.value
    })
    this.isFetching = computed(() => this.current$.value?.entry.isFetching.value ?? false)
    this.isStale = computed(() => this.current$.value?.entry.isStale.value ?? true)
    this.lastUpdatedAt = computed(() => this.current$.value?.entry.lastUpdatedAt.value)
    this.hasPendingMutations = computed(
      () => this.current$.value?.entry.hasPendingMutations.value ?? false,
    )
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
  }

  detach(): void {
    this.current$.set(null)
  }

  refetch = (): Promise<TPage[]> => {
    const cur = this.current$.peek()
    if (!cur) return Promise.reject(new Error('[olas] no active subscription'))
    return cur.entry.refetch().then(() => cur.entry.pages.peek())
  }

  reset = (): void => {
    this.current$.peek()?.entry.reset()
  }

  firstValue = (): Promise<TPage[]> => {
    const cur = this.current$.peek()
    if (!cur) return Promise.reject(new Error('[olas] no active subscription'))
    return cur.entry.firstValue()
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

export function createInfiniteUse<Args extends unknown[], TPage, TItem>(
  client: QueryClient,
  query: InfiniteQuery<Args, TPage, TItem>,
  keyOrOptions?: (() => Args) | UseOptions<Args>,
): {
  subscription: InfiniteQuerySubscription<TPage, TItem>
  dispose: () => void
  suspend: () => void
  resume: () => void
} {
  const spec = (query as unknown as InfiniteQueryInternal<Args, TPage, TItem>).__spec
  const keepPreviousData = spec.keepPreviousData ?? false
  const keyFn = typeof keyOrOptions === 'function' ? keyOrOptions : keyOrOptions?.key
  const enabledFn =
    typeof keyOrOptions === 'object' && keyOrOptions !== null ? keyOrOptions.enabled : undefined

  const sub = new InfiniteSubscriptionImpl<TPage, TItem>(keepPreviousData)
  let currentEntry: InfiniteClientEntry<TPage, TItem, unknown> | null = null
  let suspended = false

  const effectDispose = effect(() => {
    if (suspended) return
    const isEnabled = enabledFn ? enabledFn() : true
    if (!isEnabled) {
      untracked(() => {
        if (currentEntry) {
          currentEntry.release()
          currentEntry = null
        }
        sub.detach()
      })
      return
    }

    const args = (keyFn ? keyFn() : ([] as unknown as Args)) as Args

    untracked(() => {
      const entry = client.bindInfiniteEntry<Args, TPage, TItem>(query, args)
      if (currentEntry === entry) return
      if (currentEntry) currentEntry.release()
      entry.acquire()
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
      currentEntry.release()
      currentEntry = null
    }
    sub.detach()
  }

  const suspend = (): void => {
    if (suspended) return
    suspended = true
    if (currentEntry) {
      currentEntry.release()
      currentEntry = null
    }
  }

  const resume = (): void => {
    if (!suspended) return
    suspended = false
    const isEnabled = enabledFn ? enabledFn() : true
    if (!isEnabled) return
    const args = (keyFn ? keyFn() : ([] as unknown as Args)) as Args
    const entry = client.bindInfiniteEntry<Args, TPage, TItem>(query, args)
    entry.acquire()
    currentEntry = entry
    sub.attach(entry)
    const status = entry.entry.status.peek()
    if (status === 'idle' || entry.entry.isStaleNow() || status === 'error') {
      entry.entry.startFetch().catch(() => {
        /* error captured on entry */
      })
    }
  }

  return { subscription: sub, dispose, suspend, resume }
}
