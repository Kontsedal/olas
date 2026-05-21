import { effect, untracked } from '../signals'
import type { ReadSignal } from '../signals/types'
import { Entry } from './entry'
import type { LocalCache, Snapshot } from './types'

export type LocalCacheOptions<T> = {
  key?: () => readonly unknown[]
  staleTime?: number
  keepPreviousData?: boolean
  initialData?: T | undefined
}

class LocalCacheImpl<T> implements LocalCache<T> {
  private readonly entry: Entry<T>
  private keyEffectDispose: (() => void) | null = null
  private disposed = false
  private readonly keepPreviousData: boolean
  private lastSucceededFor: unknown[] | null = null

  constructor(fetcher: (signal: AbortSignal) => Promise<T>, options: LocalCacheOptions<T>) {
    this.keepPreviousData = options.keepPreviousData ?? false
    this.entry = new Entry<T>({
      fetcher: () => fetcher,
      staleTime: options.staleTime ?? 0,
      initialData: options.initialData,
    })

    if (options.key) {
      const keyFn = options.key
      this.keyEffectDispose = effect(() => {
        // Track keys.
        const keyArgs = keyFn() as unknown[]
        untracked(() => {
          if (!this.keepPreviousData) {
            // Reset data on key change so consumers see "loading" rather than
            // the previous key's stale value.
            if (this.lastSucceededFor != null && !arraysEqual(this.lastSucceededFor, keyArgs)) {
              this.entry.data.set(undefined)
            }
          }
          this.entry.startFetch().then(
            () => {
              this.lastSucceededFor = [...keyArgs]
            },
            () => {
              /* error already captured on entry */
            },
          )
        })
      })
    } else {
      this.entry.startFetch().catch(() => {
        /* error already captured on entry */
      })
    }
  }

  get data(): ReadSignal<T | undefined> {
    return this.entry.data
  }
  get error(): ReadSignal<unknown | undefined> {
    return this.entry.error
  }
  get status(): ReadSignal<'idle' | 'pending' | 'success' | 'error'> {
    return this.entry.status
  }
  get isLoading(): ReadSignal<boolean> {
    return this.entry.isLoading
  }
  get isFetching(): ReadSignal<boolean> {
    return this.entry.isFetching
  }
  get isStale(): ReadSignal<boolean> {
    return this.entry.isStale
  }
  get lastUpdatedAt(): ReadSignal<number | undefined> {
    return this.entry.lastUpdatedAt
  }
  get hasPendingMutations(): ReadSignal<boolean> {
    return this.entry.hasPendingMutations
  }

  refetch = (): Promise<T> => this.entry.refetch()
  reset = (): void => this.entry.reset()
  firstValue = (): Promise<T> => this.entry.firstValue()
  promise = (): Promise<T> => this.entry.firstValue()
  invalidate = (): void => {
    this.entry.invalidate().catch(() => {})
  }
  setData = (updater: (prev: T | undefined) => T): Snapshot => this.entry.setData(updater)

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.keyEffectDispose?.()
    this.keyEffectDispose = null
    this.entry.dispose()
  }
}

export function createLocalCache<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: LocalCacheOptions<T>,
): LocalCache<T> {
  return new LocalCacheImpl(fetcher, options ?? {})
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}
