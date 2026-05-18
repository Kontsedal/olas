import type { ReadSignal } from '../signals/types'

export type AsyncStatus = 'idle' | 'pending' | 'success' | 'error'

export type AsyncState<T> = {
  data: ReadSignal<T | undefined>
  error: ReadSignal<unknown | undefined>
  status: ReadSignal<AsyncStatus>
  isLoading: ReadSignal<boolean>
  isFetching: ReadSignal<boolean>
  isStale: ReadSignal<boolean>
  lastUpdatedAt: ReadSignal<number | undefined>
  hasPendingMutations: ReadSignal<boolean>

  refetch: () => Promise<T>
  reset: () => void
  firstValue: () => Promise<T>
}

export type Snapshot = { rollback: () => void }

export type LocalCache<T> = AsyncState<T> & {
  invalidate(): void
  setData(updater: (prev: T | undefined) => T): Snapshot
  dispose(): void
}

export type DehydratedEntry = {
  key: readonly unknown[]
  data: unknown
  lastUpdatedAt: number
}

export type DehydratedState = {
  version: 1
  entries: DehydratedEntry[]
}

export type RetryPolicy = number | ((attempt: number, error: unknown) => boolean)
export type RetryDelay = number | ((attempt: number) => number)

export type QuerySpec<Args extends unknown[], T> = {
  key: (...args: Args) => unknown[]
  fetcher: (...args: [...Args, signal: AbortSignal]) => Promise<T>
  staleTime?: number
  gcTime?: number
  refetchInterval?: number
  refetchOnWindowFocus?: boolean
  refetchOnReconnect?: boolean
  keepPreviousData?: boolean
  retry?: RetryPolicy
  retryDelay?: RetryDelay
}

export type Query<Args extends unknown[], T> = {
  readonly __olas: 'query'
  invalidate(...args: Args): void
  invalidateAll(): void
  setData(...args: [...Args, updater: (prev: T | undefined) => T]): Snapshot
  prefetch(...args: Args): Promise<T>
}

export type QuerySubscription<T> = AsyncState<T>

export type UseOptions<Args extends readonly unknown[]> = {
  key?: () => Args
  enabled?: () => boolean
}
