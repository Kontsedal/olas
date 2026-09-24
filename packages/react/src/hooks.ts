import {
  type AsyncState,
  type AsyncStatus,
  computed,
  type Field,
  type FieldTransform,
  type Mutation,
  type MutationRun,
  type ReadSignal,
} from '@kontsedal/olas-core'
import { type ChangeEvent, useCallback, useMemo, useRef, useSyncExternalStore } from 'react'

/**
 * Wrap a signal subscribe so the synchronous "initial-value" call that
 * `@preact/signals-core` (and Olas signals) fire on `subscribe(handler)` does
 * NOT translate into a React store-change notification. React already gets
 * the initial value through `getSnapshot()`; routing it through subscribe
 * would just cause spurious work — and in some setups (e.g. RTL's act-less
 * renders) confuse useSyncExternalStore's tear-detection.
 *
 * Now delegates to the core's `subscribeChanges` so the skip-initial
 * semantics live in one place.
 */
function subscribeOnChange<T>(s: ReadSignal<T>, onChange: () => void): () => void {
  return s.subscribeChanges(() => onChange())
}

const isAbortError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'

/** Options for `useValue`. */
export type UseValueOptions<T> = {
  /** Decides when a new value re-renders. Default `Object.is`. */
  isEqual?: (a: T, b: T) => boolean
}

/** Options for `useValue` with a projection: the hook returns `select(value)`. */
export type UseValueSelectOptions<T, U> = {
  /** Project the value. The hook returns the projection and compares it with `isEqual`. */
  select: (value: T) => U
  /** Decides when a new projection re-renders. Default `Object.is`. */
  isEqual?: (a: U, b: U) => boolean
}

/**
 * Subscribe to a single read-signal and return its current value. Any
 * `ReadSignal` works: a `signal`, a `computed`, a `Field`, a `Form` or a
 * `FieldArray`.
 *
 * Built on `useSyncExternalStore` — concurrent-safe, no tearing. Use this
 * when a component depends on one signal; for `Field<T>` and `AsyncState<T>`,
 * prefer `useField` and `useQuery` which batch multiple subscribes into one
 * render trigger.
 *
 * Optional `select` projects the signal value into a derived slice; `isEqual`
 * (default `Object.is`) controls when React re-renders. Combine to subscribe
 * to a slice of an object-shaped signal without re-rendering on unrelated
 * changes:
 *
 * ```ts
 * const name = useValue(userSignal, { select: u => u.name })
 * const tags = useValue(postSignal, {
 *   select: p => p.tags,
 *   isEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
 * })
 * ```
 */
export function useValue<T, U>(signal: ReadSignal<T>, options: UseValueSelectOptions<T, U>): U
export function useValue<T>(signal: ReadSignal<T>, options?: UseValueOptions<T>): T
export function useValue<T, U = T>(
  signal: ReadSignal<T>,
  options?: { select?: (value: T) => U; isEqual?: (a: U, b: U) => boolean },
): T | U {
  // Cache the last derived slice + raw input so `getSnapshot` returns a
  // stable reference unless `isEqual` says otherwise. Without this, a
  // selector returning a fresh object every call would loop React.
  const lastRef = useRef<{
    raw: T
    out: T | U
    select: ((value: T) => U) | undefined
    initialized: boolean
  }>({
    raw: undefined as unknown as T,
    out: undefined as unknown as T | U,
    select: undefined,
    initialized: false,
  })
  const select = options?.select
  const isEqual = options?.isEqual

  const subscribe = useCallback(
    (onChange: () => void) => subscribeOnChange(signal, onChange),
    [signal],
  )
  const getSnapshot = useCallback((): T | U => {
    const raw = signal.peek()
    const last = lastRef.current
    // Recompute when `raw` changed OR the `select` identity changed — a new
    // selector (e.g. `s => s.items[props.index]` with a fresh index) must
    // re-derive even when `raw` is the same reference, else the hook returns
    // the PREVIOUS selector's slice (T4.4).
    if (!last.initialized || !Object.is(last.raw, raw) || last.select !== select) {
      const next = (select ? select(raw) : raw) as T | U
      // `isEqual` stabilizes the reference only across re-evaluations of the
      // SAME selector; a selector change always yields the new slice.
      if (last.initialized && last.select === select && isEqual?.(last.out as U, next as U)) {
        last.raw = raw // remember the new raw so the equality check fires once
        return last.out
      }
      last.raw = raw
      last.out = next
      last.select = select
      last.initialized = true
    }
    return last.out
  }, [signal, select, isEqual])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const warnedDisabled = new WeakSet<object>()

function warnSuspendedWhileDisabled(subscription: object): void {
  if (warnedDisabled.has(subscription)) return
  warnedDisabled.add(subscription)
  console.warn(
    '[olas] useQuery({ suspense: true }) is suspending on a disabled query. It stays ' +
      'suspended until the query is enabled and loads. If the query may never be ' +
      'enabled, render this subtree only when it is.',
  )
}

/**
 * What `useQuery` returns: every `AsyncState` signal read as a plain value,
 * plus its actions.
 */
export type UseQueryResult<T> = {
  data: T | undefined
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  isPaused: boolean
  /** `false` while the subscription's `enabled` returns `false`. */
  isEnabled: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
  reset: () => void
  cancel: () => void
}

/** What `useSuspenseQuery` (and `useQuery(sub, { suspense: true })`) returns. */
export type UseSuspenseQueryResult<T> = Omit<UseQueryResult<T>, 'data'> & { data: T }

/**
 * Subscribe to every signal on an `AsyncState<T>` with a single
 * useSyncExternalStore call. Returns the plain values plus the action
 * functions. See spec §20.10.
 *
 * Pass `{ suspense: true }` to opt into React 18/19 Suspense semantics:
 *
 *  - While `status === 'pending'` (no data yet) the hook **throws**
 *    `subscription.firstValue()` — caught by the nearest `<Suspense>` boundary.
 *  - When `status === 'error'` AND there's no data yet, the hook **throws**
 *    `subscription.error` — caught by the nearest `<ErrorBoundary>` (React
 *    itself doesn't ship one; use `react-error-boundary` or your own). A
 *    background-refetch failure that keeps the last-good data does NOT throw.
 *  - On success the hook returns synchronously and `data` is narrowed to
 *    `T` (never `undefined`).
 *  - A disabled (`enabled: () => false`) query suspends until it is enabled
 *    and loads, because `firstValue()` waits for the subscription to attach.
 *    That is what a dependent query wants. A query that is never enabled keeps
 *    the fallback up, and development builds warn once when that starts.
 *
 *  Refetches AFTER a first success do NOT re-suspend — only the initial load
 *  throws. `reset()` does NOT re-suspend either: it clears `error`/`status` but
 *  keeps `data`, so `status` returns to `'success'` (spec §5). There is no
 *  built-in way to force re-suspension short of a fresh subscription.
 */
export function useQuery<T>(subscription: AsyncState<T>): UseQueryResult<T>
export function useQuery<T>(
  subscription: AsyncState<T>,
  options: { suspense: true },
): UseSuspenseQueryResult<T>
export function useQuery<T>(
  subscription: AsyncState<T>,
  options?: { suspense?: boolean },
): UseQueryResult<T> {
  // A memoized `computed` snapshot: reading each signal's `.value` inside makes
  // the computed re-evaluate (and mint a NEW object) exactly when any of them
  // changes, and return the SAME object when nothing did. `getSnapshot` returns
  // that object, so uSES's mount-consistency re-check compares real store state
  // — unlike the old version counter, which only bumped inside `subscribe` and
  // so missed writes landing between render and subscription (T4.5).
  const snapshot = useMemo(
    () =>
      computed(() => ({
        data: subscription.data.value,
        error: subscription.error.value,
        status: subscription.status.value,
        isLoading: subscription.isLoading.value,
        isFetching: subscription.isFetching.value,
        isStale: subscription.isStale.value,
        isPaused: subscription.isPaused.value,
        isEnabled: subscription.isEnabled.value,
        lastUpdatedAt: subscription.lastUpdatedAt.value,
        hasPendingMutations: subscription.hasPendingMutations.value,
      })),
    [subscription],
  )
  const subscribe = useCallback(
    (onChange: () => void) => snapshot.subscribeChanges(onChange),
    [snapshot],
  )
  const getSnapshot = useCallback(() => snapshot.value, [snapshot])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Suspense decisions apply ONLY when there's no data to show. A
  // background-refetch failure keeps the last-good `data` (Entry.applyFailure
  // preserves it) but sets `status: 'error'` — this whole block is skipped then,
  // so a transient blip can't nuke a rendered subtree to the ErrorBoundary. The
  // error stays observable via a non-suspense `useQuery`'s `error`/`status` (T4.3).
  if (options?.suspense === true && snap.data === undefined) {
    if (snap.status === 'error') {
      throw subscription.error.peek() // → ErrorBoundary (no data yet)
    }
    // No data and not errored → suspend (pending / idle / offline-parked / disabled).
    // The thrown promise resolves once data lands; for a disabled query that
    // means once it is enabled and loaded. `firstValue()` returns the same
    // promise while it is pending, so a re-render re-throws the one React holds.
    // A hard error for the disabled case was tried (T4.7): an idle subscription
    // could not be told from one torn down during dispose, so it fired during
    // teardown. `isEnabled` tells them apart now, and a warning is enough.
    if (__DEV__ && !snap.isEnabled) warnSuspendedWhileDisabled(subscription)
    throw subscription.firstValue()
  }

  return {
    ...snap,
    refetch: subscription.refetch,
    reset: subscription.reset,
    cancel: subscription.cancel,
  }
}

/**
 * Suspense-first variant of `useQuery`. `data` is always `T` (the hook
 * suspends until the first success, after which refetches don't re-suspend).
 * Errors throw to the nearest ErrorBoundary **only on the initial load, before
 * any data lands** — a later background-refetch failure keeps the last-good
 * data rendered (the error stays observable via a non-suspense `useQuery`).
 * Same fan-out as `useQuery` — one `useSyncExternalStore` registration over the
 * subscription signals.
 *
 * Sugar over `useQuery(sub, { suspense: true })`; exists so call sites
 * read as `useSuspenseQuery(sub)` without an options bag.
 */
export function useSuspenseQuery<T>(subscription: AsyncState<T>): UseSuspenseQueryResult<T> {
  return useQuery(subscription, { suspense: true })
}

/** What `useField` returns: the field's signals as plain values, plus its actions. */
export type UseFieldResult<T> = {
  value: T
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
  /**
   * Pin externally-sourced errors on this field (typically server-side
   * validation results). Kept separate from validator errors and cleared
   * automatically on the next user write — same channel as `Field.setErrors`.
   */
  setErrors: (errors: ReadonlyArray<string>) => void
}

/**
 * Subscribe to all signals on a `Field<T>` with a single useSyncExternalStore
 * call. Returns the plain values plus the action methods so a binding to an
 * `<input>` is one destructure. See spec §20.10.
 */
export function useField<T>(field: Field<T>): UseFieldResult<T> {
  // Memoized `computed` snapshot — see `useQuery` for why this replaces the
  // old version counter (T4.5). `field.value` reads `value$.value` (tracked).
  const snapshot = useMemo(
    () =>
      computed(() => ({
        value: field.value,
        errors: field.errors.value,
        isValid: field.isValid.value,
        isDirty: field.isDirty.value,
        touched: field.touched.value,
        isValidating: field.isValidating.value,
      })),
    [field],
  )
  const subscribe = useCallback(
    (onChange: () => void) => snapshot.subscribeChanges(onChange),
    [snapshot],
  )
  const getSnapshot = useCallback(() => snapshot.value, [snapshot])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Stable identities, so a memoized child that takes `set` doesn't re-render.
  const actions = useMemo(
    () => ({
      set: (next: T) => field.set(next),
      setAsInitial: (next: T) => field.setAsInitial(next),
      reset: () => field.reset(),
      markTouched: () => field.markTouched(),
      revalidate: () => field.revalidate(),
      setErrors: (errs: ReadonlyArray<string>) => field.setErrors(errs),
    }),
    [field],
  )
  return { ...snap, ...actions }
}

/** Options for `useFieldInput`. A field whose value is not a string needs `transform`. */
export type UseFieldInputOptions<T> = {
  /** Converts between the field's value and the input's string. */
  transform?: FieldTransform<T>
  /** Passed through as the input's `name`. */
  name?: string
}

/** Props `useFieldInput` returns, ready to spread onto a native input. */
export type UseFieldInputResult = {
  value: string
  onChange: (e: ChangeEvent<{ value: string }>) => void
  onBlur: () => void
  name: string | undefined
  'aria-invalid': boolean | undefined
}

/**
 * JSX-ready spread for binding a `Field<T>` to a native `<input>` /
 * `<textarea>` / `<select>`. Subscribes to the field's value, errors, and
 * touched signals; returns props you can spread directly:
 *
 * ```tsx
 * <input {...useFieldInput(form.fields.title)} />
 * ```
 *
 * For non-string fields, pass a `transform`:
 *
 * ```tsx
 * <input
 *   type="number"
 *   {...useFieldInput(form.fields.age, {
 *     transform: { parse: Number, format: String },
 *   })}
 * />
 * ```
 *
 * The returned `onChange` reads `e.target.value` and writes through the
 * transform; `onBlur` calls `markTouched()` so `validateOn: 'blur'` modes
 * activate without any extra wiring. `aria-invalid` is set when the field
 * has been touched AND has errors (avoid the "errors on every keystroke"
 * UX even when validators run on change). For the error *message*, render your
 * own element and point the input at it with `aria-describedby={errId}` — the
 * hook does NOT emit `aria-errormessage` because per ARIA that attribute takes
 * an element-ID reference, not the error text.
 */
export function useFieldInput<T extends string>(
  field: Field<T>,
  options?: UseFieldInputOptions<T>,
): UseFieldInputResult
export function useFieldInput<T>(
  field: Field<T>,
  options: UseFieldInputOptions<T> & { transform: FieldTransform<T> },
): UseFieldInputResult
export function useFieldInput<T>(
  field: Field<T>,
  options?: UseFieldInputOptions<T>,
): UseFieldInputResult {
  const transform = options?.transform
  // Keep the latest transform in a ref so the handlers memo keys on [field]
  // ONLY. The docstring shows an inline `transform={{ parse, format }}` literal,
  // which is a new object each render — memoizing on [field, transform] would
  // churn the handler identity every render and defeat downstream memoization
  // (T4.7). Handlers read `transformRef.current` at call time.
  const transformRef = useRef(transform)
  transformRef.current = transform

  // Memoized `computed` snapshot — see `useQuery` (T4.5).
  const snapshot = useMemo(
    () =>
      computed(() => ({
        value: field.value,
        errors: field.errors.value,
        touched: field.touched.value,
      })),
    [field],
  )
  const subscribe = useCallback(
    (onChange: () => void) => snapshot.subscribeChanges(onChange),
    [snapshot],
  )
  const getSnapshot = useCallback(() => snapshot.value, [snapshot])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const handlers = useMemo(() => {
    const onChangeHandler = (e: ChangeEvent<{ value: string }>): void => {
      const raw = e.target.value
      const t = transformRef.current
      if (t === undefined) {
        // Caller asserted `T extends string`; safe to cast.
        field.set(raw as unknown as T)
      } else {
        field.set(t.parse(raw))
      }
    }
    const onBlurHandler = (): void => field.markTouched()
    return { onChangeHandler, onBlurHandler }
  }, [field])

  const formatted =
    transform === undefined ? (snap.value as unknown as string) : transform.format(snap.value)
  const showError = snap.touched && snap.errors.length > 0
  return {
    value: formatted,
    onChange: handlers.onChangeHandler,
    onBlur: handlers.onBlurHandler,
    name: options?.name,
    // `aria-invalid` only — `aria-errormessage` per ARIA is an element-ID
    // reference, NOT error text. Consumers wire `aria-describedby` to their own
    // error element (T4.7).
    'aria-invalid': showError ? true : undefined,
  }
}

/**
 * Callbacks `useMutation` runs after a run settles. They fire from the React
 * layer, not the controller: put cache work on the mutation's own hooks.
 * A run that was aborted (superseded, reset or disposed) fires none of them,
 * as the mutation's own hooks don't.
 */
export type UseMutationCallbacks<V, R> = {
  onSuccess?: (data: R, variables: V) => void
  onError?: (error: unknown, variables: V) => void
  onSettled?: (data: R | undefined, error: unknown | undefined, variables: V) => void
}

/** `useMutation`'s fire-and-forget trigger: `run`'s arguments, no promise. */
export type MutateFn<V> = (...args: Parameters<MutationRun<V, unknown>>) => void

/** What `useMutation` returns: the mutation's signals as plain values, plus its triggers. */
export type UseMutationResult<V, R> = {
  data: R | undefined
  error: unknown | undefined
  /** Outcome of the latest run. See `Mutation.status`. */
  status: AsyncStatus
  /** True while any run is in flight. */
  isPending: boolean
  isIdle: boolean
  isSuccess: boolean
  isError: boolean
  lastVariables: V | undefined
  /**
   * Start a run and return nothing — the call for an event handler. A failure
   * lands on `error` / `status` and in `onError`; it never becomes an
   * unhandled rejection.
   */
  mutate: MutateFn<V>
  /** Start a run and return its promise. The caller owns the rejection. */
  run: MutationRun<V, R>
  reset: () => void
}

/**
 * Subscribe to all signals on a `Mutation<V, R>` with a single
 * useSyncExternalStore call. Returns the observable values plus two triggers:
 *
 * - `mutate(vars)` for an event handler. It returns nothing, and a failure
 *   surfaces on `error` / `status` and through `onError`.
 * - `run(vars)` when the caller needs the result. It returns the run's promise,
 *   which rejects on failure.
 *
 * The hook is a subscription layer: concurrency (`latest-wins`, `serial`, …)
 * is configured on the mutation in the controller.
 */
export function useMutation<V, R>(
  mutation: Mutation<V, R>,
  callbacks?: UseMutationCallbacks<V, R>,
): UseMutationResult<V, R> {
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks

  // Memoized `computed` snapshot — see `useQuery` (T4.5).
  const snapshot = useMemo(
    () =>
      computed(() => ({
        data: mutation.data.value,
        error: mutation.error.value,
        isPending: mutation.isPending.value,
        status: mutation.status.value,
        lastVariables: mutation.lastVariables.value,
      })),
    [mutation],
  )
  const subscribe = useCallback(
    (onChange: () => void) => snapshot.subscribeChanges(onChange),
    [snapshot],
  )
  const getSnapshot = useCallback(() => snapshot.value, [snapshot])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const actions = useMemo(() => {
    const run = (...args: unknown[]): Promise<R> => {
      const vars = args[0] as V
      // The returned promise is the derived one, so a caller that ignores a
      // failed `run` sees an unhandled rejection rather than a silent drop.
      return (mutation.run as (vars: V) => Promise<R>)(vars).then(
        (data) => {
          cbRef.current?.onSuccess?.(data, vars)
          cbRef.current?.onSettled?.(data, undefined, vars)
          return data
        },
        (err: unknown) => {
          if (!isAbortError(err)) {
            cbRef.current?.onError?.(err, vars)
            cbRef.current?.onSettled?.(undefined, err, vars)
          }
          throw err
        },
      )
    }
    const mutate = (...args: unknown[]): void => {
      // The failure is already on `error` / `status` and in `onError`.
      run(...args).catch(() => {})
    }
    return {
      run: run as MutationRun<V, R>,
      mutate: mutate as MutateFn<V>,
      reset: () => mutation.reset(),
    }
  }, [mutation])

  // Derive from the core `status` signal, NOT from `data` — a `void` mutation
  // resolves `undefined`, so the old `data !== undefined` heuristic left
  // `isSuccess` false forever and `isIdle` true (T4.2).
  return {
    data: snap.data,
    error: snap.error,
    status: snap.status,
    isPending: snap.isPending,
    isIdle: snap.status === 'idle',
    isSuccess: snap.status === 'success',
    isError: snap.status === 'error',
    lastVariables: snap.lastVariables,
    ...actions,
  }
}
