import { createRootWithProps } from './controller/root'
import type { ControllerDef, Field, Root, RootOptions } from './controller/types'
import { type QueryEngine, queryEngine } from './query/engine'
import type { AsyncState, AsyncStatus } from './query/types'
import { computed, type ReadSignal, type Signal, signal } from './signals'

// Test-only registry teardown — lives on the `@kontsedal/olas-core/testing`
// sub-path, NOT the public entry (T3.9). Lets tests reusing a `mutationId`
// across cases avoid registry bleed.
export { _unregisterMutationById } from './query/plugin'

/**
 * Options for `createTestController`. Mirrors `RootOptions`, with two test
 * conveniences: `props` may be omitted when the controller takes none, and
 * the query engine defaults to a live one.
 */
export type TestControllerOptions<Props, TDeps> = {
  deps: TDeps
  onError?: RootOptions<TDeps>['onError']
  /**
   * Root-wide query defaults, same shape as `createRoot`'s. Exposed here so
   * a controller whose behavior depends on them (staleTime-driven refetch,
   * retry counts) can be tested without hand-rolling a root wrapper.
   */
  defaultQueryOptions?: RootOptions<TDeps>['defaultQueryOptions']
  /**
   * The query engine. Unlike `createRoot`, this defaults to a live one:
   * a test controller exists to exercise a controller's behavior, and
   * making every test opt in to the cache would be noise. Pass `null` to
   * assert the no-engine path.
   */
  queries?: QueryEngine | null
  plugins?: RootOptions<TDeps>['plugins']
  scopes?: RootOptions<TDeps>['scopes']
  hydrate?: RootOptions<TDeps>['hydrate']
} & ([Props] extends [void] ? { props?: Props } : { props: Props })

/**
 * Construct an isolated root around one controller, for tests. Returns the
 * same handle `createRoot` does, so the api is on `.api`:
 *
 * ```ts
 * const { api, dispose } = createTestController(counter, { deps: {} })
 * api.increment()
 * ```
 */
export function createTestController<
  Props,
  Api,
  TDeps extends Record<string, unknown> = Record<string, unknown>,
>(def: ControllerDef<Props, Api>, options: TestControllerOptions<Props, TDeps>): Root<Api> {
  return createRootWithProps<Props, Api, TDeps>(def, options.props as Props, {
    deps: options.deps,
    onError: options.onError,
    defaultQueryOptions: options.defaultQueryOptions,
    queries: options.queries === null ? undefined : (options.queries ?? queryEngine()),
    plugins: options.plugins,
    scopes: options.scopes,
    hydrate: options.hydrate,
  })
}

/**
 * Shape-correct fake `Field<T>` for UI tests. Pass an initial value plus any
 * overrides for the read-only signals. The returned object satisfies `Field<T>`
 * so it can be passed straight into `useField(...)` or any component that
 * accepts a real field. See spec §20.10.
 */
export function fakeField<T>(
  initial: T,
  overrides?: Partial<{
    errors: string[]
    isValid: boolean
    isDirty: boolean
    touched: boolean
    isValidating: boolean
    set: (value: T) => void
    setAsInitial: (value: T) => void
    reset: () => void
    markTouched: () => void
    revalidate: () => Promise<boolean>
    setErrors: (errors: ReadonlyArray<string>) => void
    dispose: () => void
  }>,
): Field<T> {
  const value$: Signal<T> = signal(initial)
  const errors$: Signal<string[]> = signal(overrides?.errors ?? [])
  const touched$: Signal<boolean> = signal(overrides?.touched ?? false)
  const dirty$: Signal<boolean> = signal(overrides?.isDirty ?? false)
  const validating$: Signal<boolean> = signal(overrides?.isValidating ?? false)
  const isValid$: ReadSignal<boolean> =
    overrides?.isValid !== undefined
      ? signal(overrides.isValid)
      : computed(() => errors$.value.length === 0 && !validating$.value)

  let currentInitial = initial
  const set = overrides?.set ?? ((next: T) => value$.set(next))
  const setAsInitial =
    overrides?.setAsInitial ??
    ((next: T) => {
      currentInitial = next
      value$.set(next)
      dirty$.set(false)
    })
  const fake: Field<T> = {
    get value() {
      return value$.value
    },
    peek: () => value$.peek(),
    subscribe: (handler) => value$.subscribe(handler),
    subscribeChanges: (handler) => value$.subscribeChanges(handler),
    errors: errors$,
    isValid: isValid$,
    isDirty: dirty$,
    touched: touched$,
    isValidating: validating$,
    set,
    setAsInitial,
    reset: overrides?.reset ?? (() => value$.set(currentInitial)),
    markTouched: overrides?.markTouched ?? (() => touched$.set(true)),
    revalidate: overrides?.revalidate ?? (async () => errors$.peek().length === 0),
    setErrors: overrides?.setErrors ?? ((errs) => errors$.set([...errs])),
    dispose: overrides?.dispose ?? (() => {}),
  }
  return fake
}

/**
 * Shape-correct fake `AsyncState<T>` for UI tests. Pass overrides for any of
 * the signal-backed properties; everything else falls back to inert defaults.
 * The returned object satisfies `AsyncState<T>` so it can stand in for a real
 * query subscription in component tests. See spec §20.10.
 */
export function fakeAsyncState<T>(
  overrides?: Partial<{
    data: T | undefined
    error: unknown | undefined
    status: AsyncStatus
    isLoading: boolean
    isFetching: boolean
    isStale: boolean
    lastUpdatedAt: number | undefined
    hasPendingMutations: boolean
    isPaused: boolean
    refetch: () => Promise<T>
    reset: () => void
    firstValue: () => Promise<T>
    promise: () => Promise<T>
  }>,
): AsyncState<T> {
  const data$: ReadSignal<T | undefined> = signal(overrides?.data)
  const error$: ReadSignal<unknown | undefined> = signal(overrides?.error)
  const status$: ReadSignal<AsyncStatus> = signal(
    overrides?.status ?? (overrides?.data !== undefined ? 'success' : 'idle'),
  )
  const isLoading$: ReadSignal<boolean> = signal(overrides?.isLoading ?? false)
  const isFetching$: ReadSignal<boolean> = signal(overrides?.isFetching ?? false)
  const isStale$: ReadSignal<boolean> = signal(overrides?.isStale ?? false)
  const lastUpdatedAt$: ReadSignal<number | undefined> = signal(overrides?.lastUpdatedAt)
  const hasPendingMutations$: ReadSignal<boolean> = signal(overrides?.hasPendingMutations ?? false)
  const isPaused$: ReadSignal<boolean> = signal(overrides?.isPaused ?? false)

  const refetch = overrides?.refetch ?? (async () => data$.peek() as T)
  const reset = overrides?.reset ?? (() => {})
  const firstValue = overrides?.firstValue ?? (async () => data$.peek() as T)
  const promise = overrides?.promise ?? firstValue

  return {
    data: data$,
    error: error$,
    status: status$,
    isLoading: isLoading$,
    isFetching: isFetching$,
    isStale: isStale$,
    lastUpdatedAt: lastUpdatedAt$,
    hasPendingMutations: hasPendingMutations$,
    isPaused: isPaused$,
    refetch,
    reset,
    firstValue,
    promise,
  }
}
