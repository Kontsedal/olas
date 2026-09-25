import type {
  AsyncState,
  AsyncStatus,
  Field,
  InfiniteQuerySubscription,
  Mutation,
  MutationRun,
  ReadSignal,
  Root,
} from '@kontsedal/olas-core'
import {
  type App,
  customRef,
  getCurrentScope,
  type InjectionKey,
  inject,
  onScopeDispose,
  type Ref,
  computed as vueComputed,
  type WritableComputedRef,
} from 'vue'

/**
 * Register the app's root type once, and `useRoot()` returns its api with no
 * type argument. Empty here: the app adds `root` through declaration merging.
 *
 * ```ts
 * declare module '@kontsedal/olas-vue' {
 *   interface Register {
 *     root: typeof root
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by the app, once
export interface Register {}

/** The api `useRoot()` returns by default: the registered root's, else `unknown`. */
export type RegisteredApi = Register extends { root: Root<infer Api> } ? Api : unknown

const ROOT_KEY: InjectionKey<Root<unknown>> = Symbol('olas-root')

/**
 * The Vue plugin that provides a root to the whole app. The root is built
 * outside Vue, once, and `app.use` hands it to every component:
 *
 * ```ts
 * const root = createRoot(appController, { deps, queries: queryEngine() })
 * createApp(App).use(olasPlugin(root)).mount('#app')
 * ```
 */
export function olasPlugin(root: Root<unknown>): { install(app: App): void } {
  return {
    install(app) {
      app.provide(ROOT_KEY, root)
    },
  }
}

/**
 * The root's api, from the nearest `olasPlugin`. Typed by the registered
 * root (`Register`), or by `useRoot<Api>()` as an unchecked cast. Throws when
 * no plugin provided a root.
 */
export function useRoot<Api = RegisteredApi>(): Api {
  const root = inject(ROOT_KEY, null)
  if (root === null) {
    throw new Error('[olas] useRoot() found no root: install it with app.use(olasPlugin(root))')
  }
  return root.api as Api
}

/** Tie a signal subscription to the current effect scope (a component's setup). */
function onDispose(stop: () => void): void {
  if (getCurrentScope() !== undefined) onScopeDispose(stop)
}

/** The hooks that have already warned about a missing effect scope. */
let warnedOutsideScope: Set<string> | undefined

/**
 * Development builds only. Outside an effect scope nothing calls
 * `onScopeDispose`, so a hook's subscription is never ended. Warn once per
 * hook, where the call happens, naming the hook. A hook that calls another
 * (`useQuery` builds on `useValue`) checks once, under its own name. Each
 * hook calls it as `__DEV__ && warnOutsideScope(name)`, which the default
 * build drops, strings and all.
 */
function warnOutsideScope(hook: string): void {
  if (getCurrentScope() !== undefined) return
  warnedOutsideScope ??= new Set()
  if (warnedOutsideScope.has(hook)) return
  warnedOutsideScope.add(hook)
  console.warn(
    `[olas] ${hook}() ran outside a Vue effect scope, so nothing will unsubscribe it: ` +
      'its signal subscriptions stay live, and keep the refs they feed in memory, for as ' +
      "long as the signals exist. Call it from a component's setup(), or inside " +
      'effectScope().run() and call stop() on that scope when you are done.',
  )
}

/** Options for `useValue`. */
export type UseValueOptions<T> = {
  /**
   * Decides when a new value triggers Vue. Default `Object.is`.
   */
  isEqual?: (a: T, b: T) => boolean
}

/**
 * A read-only ref over any `ReadSignal`: a `signal`, a `computed`, a `Field`,
 * a `Form` or a `FieldArray`. Reading the ref reads the signal's current value,
 * so it never lags a write. The subscription ends with the component (the
 * current effect scope). Outside any scope nothing ends it, and a development
 * build warns.
 *
 * ```ts
 * const count = useValue(api.count)   // count.value in script, {{ count }} in a template
 * ```
 */
export function useValue<T>(signal: ReadSignal<T>, options?: UseValueOptions<T>): Readonly<Ref<T>> {
  __DEV__ && warnOutsideScope('useValue')
  return valueRef(signal, options?.isEqual)
}

/** `useValue` without the scope check, for the hooks built on it. */
function valueRef<T>(
  signal: ReadSignal<T>,
  isEqual: (a: T, b: T) => boolean = Object.is,
): Readonly<Ref<T>> {
  let last = signal.peek()
  let trigger: () => void = () => {}
  const ref = customRef<T>((track, triggerRef) => {
    trigger = triggerRef
    return {
      get() {
        track()
        return signal.peek()
      },
      set() {
        // Read-only: write through the signal (or `field.set`) instead.
      },
    }
  })
  onDispose(
    signal.subscribeChanges((next) => {
      if (isEqual(last, next)) return
      last = next
      trigger()
    }),
  )
  return ref as Readonly<Ref<T>>
}

/** Each field of `T` as a read-only ref: the shape the hooks return their state in. */
export type Refs<T> = { readonly [K in keyof T]: Readonly<Ref<T[K]>> }

/** What `useQuery` returns: each `AsyncState` signal as a ref, plus the actions. */
export type UseQueryReturn<T> = Refs<{
  data: T | undefined
  error: unknown
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  isPaused: boolean
  isEnabled: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
}> & {
  refetch: () => Promise<T>
  reset: () => void
  cancel: () => void
}

/**
 * Subscribe a component to a query subscription a controller made. Each field
 * is a ref, so a template reads it unwrapped when destructured:
 *
 * ```ts
 * const { data, isLoading } = useQuery(api.user)
 * ```
 */
export function useQuery<T>(subscription: AsyncState<T>): UseQueryReturn<T> {
  __DEV__ && warnOutsideScope('useQuery')
  return queryRefs(subscription)
}

function queryRefs<T>(subscription: AsyncState<T>): UseQueryReturn<T> {
  return {
    data: valueRef(subscription.data),
    error: valueRef(subscription.error),
    status: valueRef(subscription.status),
    isLoading: valueRef(subscription.isLoading),
    isFetching: valueRef(subscription.isFetching),
    isStale: valueRef(subscription.isStale),
    isPaused: valueRef(subscription.isPaused),
    isEnabled: valueRef(subscription.isEnabled),
    lastUpdatedAt: valueRef(subscription.lastUpdatedAt),
    hasPendingMutations: valueRef(subscription.hasPendingMutations),
    refetch: subscription.refetch,
    reset: subscription.reset,
    cancel: subscription.cancel,
  }
}

/** What `useInfiniteQuery` returns: `useQuery`'s fields plus the paging state and actions. */
export type UseInfiniteQueryReturn<TPage, TItem> = UseQueryReturn<TPage[]> &
  Refs<{
    pages: TPage[]
    flat: TItem[]
    hasNextPage: boolean
    hasPreviousPage: boolean
    isFetchingNextPage: boolean
    isFetchingPreviousPage: boolean
  }> & {
    fetchNextPage: () => Promise<void>
    fetchPreviousPage: () => Promise<void>
  }

/** Subscribe a component to an infinite query subscription. */
export function useInfiniteQuery<TPage, TItem>(
  subscription: InfiniteQuerySubscription<TPage, TItem>,
): UseInfiniteQueryReturn<TPage, TItem> {
  __DEV__ && warnOutsideScope('useInfiniteQuery')
  return {
    ...queryRefs(subscription),
    pages: valueRef(subscription.pages),
    flat: valueRef(subscription.flat),
    hasNextPage: valueRef(subscription.hasNextPage),
    hasPreviousPage: valueRef(subscription.hasPreviousPage),
    isFetchingNextPage: valueRef(subscription.isFetchingNextPage),
    isFetchingPreviousPage: valueRef(subscription.isFetchingPreviousPage),
    fetchNextPage: subscription.fetchNextPage,
    fetchPreviousPage: subscription.fetchPreviousPage,
  }
}

/** What `useField` returns. `value` is writable, for `v-model`. */
export type UseFieldReturn<T> = {
  /**
   * Reads the field; assigning writes through `field.set`.
   */
  value: WritableComputedRef<T>
} & Refs<{
  errors: string[]
  isValid: boolean
  isDirty: boolean
  touched: boolean
  isValidating: boolean
}> & {
    set: (value: T) => void
    setAsInitial: (value: T) => void
    reset: () => void
    markTouched: () => void
    revalidate: () => Promise<boolean>
    setErrors: (errors: ReadonlyArray<string>) => void
  }

/**
 * Bind a component to a `Field`. `value` is a writable ref, so it works with
 * `v-model` once destructured:
 *
 * ```vue
 * <script setup>
 * const { value, errors, markTouched } = useField(api.form.fields.name)
 * </script>
 * <template><input v-model="value" @blur="markTouched" /></template>
 * ```
 */
export function useField<T>(field: Field<T>): UseFieldReturn<T> {
  __DEV__ && warnOutsideScope('useField')
  const current = valueRef(field)
  return {
    value: vueComputed({ get: () => current.value, set: (next: T) => field.set(next) }),
    errors: valueRef(field.errors),
    isValid: valueRef(field.isValid),
    isDirty: valueRef(field.isDirty),
    touched: valueRef(field.touched),
    isValidating: valueRef(field.isValidating),
    set: (next) => field.set(next),
    setAsInitial: (next) => field.setAsInitial(next),
    reset: () => field.reset(),
    markTouched: () => field.markTouched(),
    revalidate: () => field.revalidate(),
    setErrors: (errs) => field.setErrors(errs),
  }
}

/** `useMutation`'s fire-and-forget trigger: `run`'s arguments, no promise. */
export type MutateFn<V> = (...args: Parameters<MutationRun<V, unknown>>) => void

/** What `useMutation` returns: the mutation's signals as refs, plus its triggers. */
export type UseMutationReturn<V, R> = Refs<{
  data: R | undefined
  error: unknown
  status: AsyncStatus
  isPending: boolean
  lastVariables: V | undefined
}> & {
  /**
   * Start a run and return nothing: a failure lands on `error` and `status`.
   */
  mutate: MutateFn<V>
  /**
   * Start a run and return its promise. The caller owns the rejection.
   */
  run: MutationRun<V, R>
  reset: () => void
}

/**
 * Subscribe a component to a mutation a controller made. `mutate` is the call
 * for an event handler; `run` returns the promise.
 */
export function useMutation<V, R>(mutation: Mutation<V, R>): UseMutationReturn<V, R> {
  __DEV__ && warnOutsideScope('useMutation')
  const run = ((...args: unknown[]) =>
    (mutation.run as (v: unknown) => Promise<R>)(args[0])) as MutationRun<V, R>
  return {
    data: valueRef(mutation.data),
    error: valueRef(mutation.error),
    status: valueRef(mutation.status),
    isPending: valueRef(mutation.isPending),
    lastVariables: valueRef(mutation.lastVariables),
    run,
    mutate: ((...args: unknown[]) => {
      ;(run as (...a: unknown[]) => Promise<R>)(...args).catch(() => {})
    }) as MutateFn<V>,
    reset: () => mutation.reset(),
  }
}
