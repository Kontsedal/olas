import { createRootWithProps } from './controller/root'
import type { ControllerDef, Field, Root, RootOptions } from './controller/types'
import { isStructurallyEqual } from './forms/field'
import { type QueryEngine, queryEngine } from './query/engine'
import type { AsyncState, AsyncStatus } from './query/types'
import { batch, computed, type ReadSignal, type Signal, signal } from './signals'

// Test-only registry teardown — lives on the `@kontsedal/olas-core/testing`
// sub-path, NOT the public entry (T3.9). Lets tests reusing a mutation `id`
// across cases avoid registry bleed.
export { _unregisterMutationById } from './query/mutation-registry'
export {
  createPluginRecorder,
  type MockFetchHandler,
  type MockFetchOptions,
  type MockFetchPlugin,
  type MockFetchResponse,
  mockFetchPlugin,
  type PluginRecorder,
  type RecordedEvent,
} from './test-plugins'

/**
 * Options for `createTestController`. Mirrors `RootOptions`, with two test
 * conveniences: `props` may be omitted when the controller takes none, and
 * the query engine defaults to a live one.
 */
export type TestControllerOptions<Props, TDeps> = {
  deps: TDeps
  onError?: RootOptions<TDeps>['onError']
  /**
   * The query engine. Unlike `createRoot`, this defaults to a live one:
   * a test controller exists to exercise a controller's behavior, and
   * making every test opt in to the cache would be noise. Pass
   * `queryEngine({ defaults })` to test against root-wide defaults, or
   * `null` to assert the no-engine path.
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
 *
 * It behaves like a real field that has no validators. `errors` seeds the
 * validator errors. `setErrors` writes a separate server channel that the next
 * `set()` clears. `set()` recomputes `isDirty` against the initial value.
 * `reset()` restores the initial value and clears dirty, touched and every
 * error. `isValid` holds `true` while `isValidating` is set, because a real
 * field with no settled pass reads valid mid-check (spec §8.2).
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
  const validatorErrors$: Signal<string[]> = signal(overrides?.errors ?? [])
  const serverErrors$: Signal<string[]> = signal([])
  const errors$: ReadSignal<string[]> = computed(() => {
    const server = serverErrors$.value
    return server.length === 0 ? validatorErrors$.value : [...validatorErrors$.value, ...server]
  })
  const touched$: Signal<boolean> = signal(overrides?.touched ?? false)
  const dirty$: Signal<boolean> = signal(overrides?.isDirty ?? false)
  const validating$: Signal<boolean> = signal(overrides?.isValidating ?? false)
  // Nothing settles a fake's validation, so the value held while validating is
  // the no-prior-pass default: valid.
  const isValid$: ReadSignal<boolean> =
    overrides?.isValid !== undefined
      ? signal(overrides.isValid)
      : computed(() => validating$.value || errors$.value.length === 0)

  let currentInitial = initial
  const set =
    overrides?.set ??
    ((next: T) =>
      batch(() => {
        value$.set(next)
        dirty$.set(!isStructurallyEqual(next, currentInitial))
        if (serverErrors$.peek().length > 0) serverErrors$.set([])
      }))
  const setAsInitial =
    overrides?.setAsInitial ??
    ((next: T) => {
      currentInitial = next
      batch(() => {
        value$.set(next)
        dirty$.set(false)
        if (serverErrors$.peek().length > 0) serverErrors$.set([])
      })
    })
  const reset =
    overrides?.reset ??
    (() =>
      batch(() => {
        value$.set(currentInitial)
        dirty$.set(false)
        touched$.set(false)
        validatorErrors$.set([])
        serverErrors$.set([])
        validating$.set(false)
      }))
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
    reset,
    markTouched: overrides?.markTouched ?? (() => touched$.set(true)),
    revalidate: overrides?.revalidate ?? (async () => errors$.peek().length === 0),
    setErrors: overrides?.setErrors ?? ((errs) => serverErrors$.set([...errs])),
    dispose: overrides?.dispose ?? (() => {}),
  }
  return fake
}

/**
 * Shape-correct fake `AsyncState<T>` for UI tests. Pass overrides for any of
 * the signal-backed properties; everything else falls back to inert defaults.
 * The returned object satisfies `AsyncState<T>` so it can stand in for a real
 * query subscription in component tests. See spec §20.10.
 *
 * The defaults follow a real subscription. `status` is `'error'` when `error`
 * is given, `'success'` when `data` is, and `'idle'` otherwise. A `'pending'`
 * status is fetching, and loading while there is no data. `firstValue()`
 * rejects with the error in the `'error'` status, resolves with the data in
 * the `'success'` status or when there is data, and otherwise stays pending,
 * as a real one waits for data.
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
    isEnabled: boolean
    refetch: () => Promise<T>
    reset: () => void
    cancel: () => void
    firstValue: () => Promise<T>
  }>,
): AsyncState<T> {
  const data$: ReadSignal<T | undefined> = signal(overrides?.data)
  const error$: ReadSignal<unknown | undefined> = signal(overrides?.error)
  const status: AsyncStatus =
    overrides?.status ??
    (overrides?.error !== undefined ? 'error' : overrides?.data !== undefined ? 'success' : 'idle')
  const status$: ReadSignal<AsyncStatus> = signal(status)
  const isLoading$: ReadSignal<boolean> = signal(
    overrides?.isLoading ?? (status === 'pending' && overrides?.data === undefined),
  )
  const isFetching$: ReadSignal<boolean> = signal(overrides?.isFetching ?? status === 'pending')
  const isStale$: ReadSignal<boolean> = signal(overrides?.isStale ?? false)
  const lastUpdatedAt$: ReadSignal<number | undefined> = signal(overrides?.lastUpdatedAt)
  const hasPendingMutations$: ReadSignal<boolean> = signal(overrides?.hasPendingMutations ?? false)
  const isPaused$: ReadSignal<boolean> = signal(overrides?.isPaused ?? false)
  const isEnabled$: ReadSignal<boolean> = signal(overrides?.isEnabled ?? true)

  const refetch = overrides?.refetch ?? (async () => data$.peek() as T)
  const reset = overrides?.reset ?? (() => {})
  const cancel = overrides?.cancel ?? (() => {})
  const firstValue =
    overrides?.firstValue ??
    ((): Promise<T> => {
      if (status === 'error') return Promise.reject(error$.peek())
      if (status === 'success' || data$.peek() !== undefined) {
        return Promise.resolve(data$.peek() as T)
      }
      // A real subscription waits for data, and nothing brings data to a fake.
      return new Promise<T>(() => {})
    })

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
    isEnabled: isEnabled$,
    refetch,
    reset,
    cancel,
    firstValue,
  }
}
