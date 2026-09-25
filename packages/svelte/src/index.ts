import {
  type AsyncState,
  type AsyncStatus,
  computed,
  type Field,
  type InfiniteQuerySubscription,
  type Mutation,
  type MutationRun,
  type ReadSignal,
  type Root,
} from '@kontsedal/olas-core'
import { getContext, hasContext, setContext } from 'svelte'

/**
 * Every Olas `ReadSignal` already satisfies Svelte's store contract: its
 * `subscribe(run)` calls `run` with the current value at once and on every
 * change, and returns the unsubscribe. So `$signal` works in a component for
 * a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray`, with no
 * wrapper. A `Field` also has `set`, which makes it a writable store:
 * `<input bind:value={$name} />` writes through `field.set`.
 *
 * This package adds the root context and store-shaped views over the
 * multi-signal objects: queries, fields and mutations.
 */

/**
 * Register the app's root type once, and `getRoot()` returns its api with no
 * type argument. Empty here: the app adds `root` through declaration merging.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by the app, once
export interface Register {}

/** The api `getRoot()` returns by default: the registered root's, else `unknown`. */
export type RegisteredApi = Register extends { root: Root<infer Api> } ? Api : unknown

const ROOT_KEY = Symbol('olas-root')

/** Provide a root to the component tree below. Call during a component's initialization. */
export function setRoot(root: Root<unknown>): void {
  setContext(ROOT_KEY, root)
}

/** The root's api, from the nearest `setRoot`. Call during a component's initialization. */
export function getRoot<Api = RegisteredApi>(): Api {
  if (!hasContext(ROOT_KEY)) {
    throw new Error('[olas] getRoot() found no root: call setRoot(root) in an ancestor component')
  }
  return (getContext(ROOT_KEY) as Root<unknown>).api as Api
}

/** A store over `state`, with `actions` beside it. Delegates rather than inherits. */
function withActions<S, A extends object>(state: ReadSignal<S>, actions: A): ReadSignal<S> & A {
  return {
    get value() {
      return state.value
    },
    peek: () => state.peek(),
    subscribe: (handler: (value: S) => void) => state.subscribe(handler),
    subscribeChanges: (handler: (value: S) => void) => state.subscribeChanges(handler),
    ...actions,
  }
}

/** A query's state as one store value. */
export type QueryState<T> = {
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
}

/** What `queryStore` returns: a store of the query's state, plus its actions. */
export type QueryStore<T> = ReadSignal<QueryState<T>> & {
  refetch: () => Promise<T>
  reset: () => void
  cancel: () => void
}

const queryState = <T>(s: AsyncState<T>): QueryState<T> => ({
  data: s.data.value,
  error: s.error.value,
  status: s.status.value,
  isLoading: s.isLoading.value,
  isFetching: s.isFetching.value,
  isStale: s.isStale.value,
  isPaused: s.isPaused.value,
  isEnabled: s.isEnabled.value,
  lastUpdatedAt: s.lastUpdatedAt.value,
  hasPendingMutations: s.hasPendingMutations.value,
})

/**
 * One store over a query subscription's signals. `$query.data`,
 * `$query.isLoading` and the rest update together, once per change.
 *
 * ```svelte
 * <script>
 *   const user = queryStore(getRoot().user)
 * </script>
 * {#if $user.isLoading}Loading…{:else}{$user.data?.name}{/if}
 * ```
 */
export function queryStore<T>(subscription: AsyncState<T>): QueryStore<T> {
  const state = computed(() => queryState(subscription))
  return withActions(state, {
    refetch: subscription.refetch,
    reset: subscription.reset,
    cancel: subscription.cancel,
  })
}

/** An infinite query's state as one store value. */
export type InfiniteQueryState<TPage, TItem> = QueryState<TPage[]> & {
  pages: TPage[]
  flat: TItem[]
  hasNextPage: boolean
  hasPreviousPage: boolean
  isFetchingNextPage: boolean
  isFetchingPreviousPage: boolean
}

/** What `infiniteQueryStore` returns. */
export type InfiniteQueryStore<TPage, TItem> = ReadSignal<InfiniteQueryState<TPage, TItem>> & {
  refetch: () => Promise<TPage[]>
  reset: () => void
  cancel: () => void
  fetchNextPage: () => Promise<void>
  fetchPreviousPage: () => Promise<void>
}

/** One store over an infinite query subscription. */
export function infiniteQueryStore<TPage, TItem>(
  subscription: InfiniteQuerySubscription<TPage, TItem>,
): InfiniteQueryStore<TPage, TItem> {
  const state = computed(() => ({
    ...queryState(subscription),
    pages: subscription.pages.value,
    flat: subscription.flat.value,
    hasNextPage: subscription.hasNextPage.value,
    hasPreviousPage: subscription.hasPreviousPage.value,
    isFetchingNextPage: subscription.isFetchingNextPage.value,
    isFetchingPreviousPage: subscription.isFetchingPreviousPage.value,
  }))
  return withActions(state, {
    refetch: subscription.refetch,
    reset: subscription.reset,
    cancel: subscription.cancel,
    fetchNextPage: subscription.fetchNextPage,
    fetchPreviousPage: subscription.fetchPreviousPage,
  })
}

/** A field's state as one store value. */
export type FieldState<T> = {
  value: T
  errors: string[]
  isValid: boolean
  isDirty: boolean
  touched: boolean
  isValidating: boolean
}

/** What `fieldStore` returns: a store of the field's state, plus its actions. */
export type FieldStore<T> = ReadSignal<FieldState<T>> & {
  set: (value: T) => void
  setAsInitial: (value: T) => void
  reset: () => void
  markTouched: () => void
  revalidate: () => Promise<boolean>
  setErrors: (errors: ReadonlyArray<string>) => void
}

/**
 * One store over a field's value and validation state, for an input that also
 * shows its errors. For the value alone, bind the field directly:
 * `bind:value={$field}`.
 */
export function fieldStore<T>(field: Field<T>): FieldStore<T> {
  const state = computed(() => ({
    value: field.value,
    errors: field.errors.value,
    isValid: field.isValid.value,
    isDirty: field.isDirty.value,
    touched: field.touched.value,
    isValidating: field.isValidating.value,
  }))
  return withActions(state, {
    set: (next: T) => field.set(next),
    setAsInitial: (next: T) => field.setAsInitial(next),
    reset: () => field.reset(),
    markTouched: () => field.markTouched(),
    revalidate: () => field.revalidate(),
    setErrors: (errs: ReadonlyArray<string>) => field.setErrors(errs),
  })
}

/** A mutation's state as one store value. */
export type MutationState<V, R> = {
  data: R | undefined
  error: unknown
  status: AsyncStatus
  isPending: boolean
  lastVariables: V | undefined
}

/** `mutationStore`'s fire-and-forget trigger: `run`'s arguments, no promise. */
export type MutateFn<V> = (...args: Parameters<MutationRun<V, unknown>>) => void

/** What `mutationStore` returns: a store of the mutation's state, plus its triggers. */
export type MutationStore<V, R> = ReadSignal<MutationState<V, R>> & {
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

/** One store over a mutation's signals. `mutate` is the call for an `on:click`. */
export function mutationStore<V, R>(mutation: Mutation<V, R>): MutationStore<V, R> {
  const state = computed(() => ({
    data: mutation.data.value,
    error: mutation.error.value,
    status: mutation.status.value,
    isPending: mutation.isPending.value,
    lastVariables: mutation.lastVariables.value,
  }))
  const run = ((...args: unknown[]) =>
    (mutation.run as (v: unknown) => Promise<R>)(args[0])) as MutationRun<V, R>
  return withActions(state, {
    run,
    mutate: ((...args: unknown[]) => {
      ;(run as (...a: unknown[]) => Promise<R>)(...args).catch(() => {})
    }) as MutateFn<V>,
    reset: () => mutation.reset(),
  })
}
