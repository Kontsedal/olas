import { effect, untracked } from '../signals'
import type { ReadSignal } from '../signals/types'
import { Entry } from './entry'
import type { FetchCtx, LocalCache, Snapshot } from './types'

/** Options for `createCache(ctx, fetcher, options?)`. Spec §5.1. */
export type LocalCacheOptions<T> = {
  key?: () => readonly unknown[]
  staleTime?: number
  keepPreviousData?: boolean
  initialData?: T | undefined
}

/** A local cache has no `enabled` switch; its `isEnabled` never changes. */
const ALWAYS_ENABLED: ReadSignal<boolean> = Object.freeze({
  value: true,
  peek: () => true,
  subscribe(handler: (value: boolean) => void): () => void {
    handler(true)
    return () => {}
  },
  subscribeChanges: (): (() => void) => () => {},
})

class LocalCacheImpl<T> implements LocalCache<T> {
  private readonly entry: Entry<T>
  private keyEffectDispose: (() => void) | null = null
  private disposed = false
  private readonly keepPreviousData: boolean
  private lastSucceededFor: unknown[] | null = null

  constructor(
    fetcher: (ctx: FetchCtx) => Promise<T>,
    options: LocalCacheOptions<T>,
    deps: FetchCtx['deps'],
  ) {
    this.keepPreviousData = options.keepPreviousData ?? false
    this.entry = new Entry<T>({
      fetcher: () => (signal) => fetcher({ signal, deps }),
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
  get isPaused(): ReadSignal<boolean> {
    return this.entry.isPaused
  }
  get isEnabled(): ReadSignal<boolean> {
    return ALWAYS_ENABLED
  }

  refetch = (): Promise<T> => this.entry.refetch()
  reset = (): void => this.entry.reset()
  firstValue = (): Promise<T> => this.entry.firstValue()
  cancel = (): void => this.entry.cancel()
  invalidate = (): Promise<void> =>
    // Resolves when the refetch settles; errors surface on the cache's `error`
    // signal (AsyncState), so the awaiter's promise resolves rather than rejects.
    this.entry.invalidate().then(
      () => {},
      () => {},
    )
  setData = (updater: (prev: T | undefined) => T): Snapshot => this.entry.setData(updater)
  // The canonical writes, with `Query`'s semantics (§6.4): no snapshot, and a
  // fetch in flight left alone by `write` and superseded by `replace`.
  write = (updater: (prev: T | undefined) => T): void => {
    this.entry.setData(updater, { track: false })
  }
  replace = (value: T): void => {
    this.entry.setData(() => value, { track: false })
    // The owning controller is the cache's one subscriber, for as long as the
    // cache exists: a discarded invalidation fetch is re-run (§6.4).
    if (value !== undefined) this.entry.supersedeByWrite(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.keyEffectDispose?.()
    this.keyEffectDispose = null
    this.entry.dispose()
  }
}

export function createLocalCache<T>(
  fetcher: (ctx: FetchCtx) => Promise<T>,
  options?: LocalCacheOptions<T>,
  deps?: FetchCtx['deps'],
): LocalCache<T> {
  return new LocalCacheImpl(fetcher, options ?? {}, deps ?? {})
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}
