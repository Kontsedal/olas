import {
  type AsyncState,
  type AsyncStatus,
  computed,
  type Field,
  type FieldTransform,
  type Mutation,
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

/**
 * Subscribe to a single read-signal and return its current value.
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
 * const name = use(userSignal, { select: u => u.name })
 * const tags = use(postSignal, {
 *   select: p => p.tags,
 *   isEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
 * })
 * ```
 */
export function use<T>(signal: ReadSignal<T>): T
export function use<T, U>(
  signal: ReadSignal<T>,
  options: { select: (value: T) => U; isEqual?: (a: U, b: U) => boolean },
): U
export function use<T>(signal: ReadSignal<T>, options: { isEqual: (a: T, b: T) => boolean }): T
export function use<T, U = T>(
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

/**
 * Subscribe to all eight signals on an `AsyncState<T>` with a single
 * useSyncExternalStore call. Returns the plain values plus the action
 * functions. See spec §20.10.
 *
 * Pass `{ suspense: true }` to opt into React 18/19 Suspense semantics:
 *
 *  - While `status === 'pending'` (no data yet) the hook **throws**
 *    `subscription.promise()` — caught by the nearest `<Suspense>` boundary.
 *  - When `status === 'error'` the hook **throws** `subscription.error` —
 *    caught by the nearest `<ErrorBoundary>` (React itself doesn't ship
 *    one; use `react-error-boundary` or your own).
 *  - On success the hook returns synchronously and `data` is narrowed to
 *    `T` (never `undefined`).
 *
 *  Refetches AFTER a first success do NOT re-suspend — only the initial
 *  load throws. To re-suspend programmatically, call `subscription.reset()`.
 */
export function useQuery<T>(subscription: AsyncState<T>): {
  data: T | undefined
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
}
export function useQuery<T>(
  subscription: AsyncState<T>,
  options: { suspense: true },
): {
  data: T
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
}
export function useQuery<T>(
  subscription: AsyncState<T>,
  options?: { suspense?: boolean },
): {
  data: T | undefined
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
} {
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

  if (options?.suspense === true) {
    // Throw to the ErrorBoundary ONLY when there's no data to show. A
    // background-refetch failure keeps the last-good `data` (Entry.applyFailure
    // preserves it) but sets `status: 'error'` — throwing then would nuke a
    // rendered subtree to the ErrorBoundary on a transient focus/interval blip.
    // TanStack's suspense throws only when data is absent; the error stays
    // observable via a non-suspense `useQuery`'s `error`/`status` (T4.3).
    if (snap.status === 'error' && snap.data === undefined) {
      throw subscription.error.peek()
    }
    // First-load suspend: only when we genuinely have no data yet. After
    // a successful settle, refetches keep `data` defined and the hook
    // returns normally (matches TanStack Query's `suspense` semantics).
    if (snap.data === undefined && (snap.status === 'pending' || snap.status === 'idle')) {
      throw subscription.promise()
    }
  }

  return {
    ...snap,
    refetch: subscription.refetch,
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
export function useSuspenseQuery<T>(subscription: AsyncState<T>): {
  data: T
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
} {
  return useQuery(subscription, { suspense: true })
}

/**
 * Subscribe to all signals on a `Field<T>` with a single useSyncExternalStore
 * call. Returns the plain values plus the action methods so a binding to an
 * `<input>` is one destructure. See spec §20.10.
 */
export function useField<T>(field: Field<T>): {
  value: T
  errors: string[]
  isValid: boolean
  isDirty: boolean
  touched: boolean
  isValidating: boolean
  set: (value: T) => void
  reset: () => void
  markTouched: () => void
  revalidate: () => Promise<boolean>
  /**
   * Pin externally-sourced errors on this field (typically server-side
   * validation results). Kept separate from validator errors and cleared
   * automatically on the next user write — same channel as `Field.setErrors`.
   */
  setErrors: (errors: ReadonlyArray<string>) => void
} {
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

  return {
    ...snap,
    set: (next: T) => field.set(next),
    reset: () => field.reset(),
    markTouched: () => field.markTouched(),
    revalidate: () => field.revalidate(),
    setErrors: (errs: ReadonlyArray<string>) => field.setErrors(errs),
  }
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
 * UX even when validators run on change).
 */
export function useFieldInput<T extends string>(
  field: Field<T>,
  options?: { name?: string },
): {
  value: string
  onChange: (e: ChangeEvent<{ value: string }>) => void
  onBlur: () => void
  name: string | undefined
  'aria-invalid': boolean | undefined
  'aria-errormessage': string | undefined
}
export function useFieldInput<T>(
  field: Field<T>,
  options: { transform: FieldTransform<T>; name?: string },
): {
  value: string
  onChange: (e: ChangeEvent<{ value: string }>) => void
  onBlur: () => void
  name: string | undefined
  'aria-invalid': boolean | undefined
  'aria-errormessage': string | undefined
}
export function useFieldInput<T>(
  field: Field<T>,
  options?: { transform?: FieldTransform<T>; name?: string },
): {
  value: string
  onChange: (e: ChangeEvent<{ value: string }>) => void
  onBlur: () => void
  name: string | undefined
  'aria-invalid': boolean | undefined
  'aria-errormessage': string | undefined
} {
  const transform = options?.transform
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

  // Build the change/blur handlers once per field/transform — useMemo over
  // [field, transform] so each remount of the same field doesn't churn
  // identity (React downstream may use the function ref for memoization).
  const handlers = useMemo(() => {
    const onChangeHandler = (e: ChangeEvent<{ value: string }>): void => {
      const raw = e.target.value
      if (transform === undefined) {
        // Caller asserted `T extends string`; safe to cast.
        field.set(raw as unknown as T)
      } else {
        field.set(transform.parse(raw))
      }
    }
    const onBlurHandler = (): void => field.markTouched()
    return { onChangeHandler, onBlurHandler }
  }, [field, transform])

  const formatted =
    transform === undefined ? (snap.value as unknown as string) : transform.format(snap.value)
  const showError = snap.touched && snap.errors.length > 0
  return {
    value: formatted,
    onChange: handlers.onChangeHandler,
    onBlur: handlers.onBlurHandler,
    name: options?.name,
    'aria-invalid': showError ? true : undefined,
    'aria-errormessage': showError ? snap.errors[0] : undefined,
  }
}

/**
 * Subscribe to all signals on a `Mutation<V, R>` with a single
 * useSyncExternalStore call. Returns the four observable values plus the
 * actions (`mutate` is a friendlier alias for `run`).
 *
 * `mutate(vars)` is the canonical way to trigger from JSX. It returns the
 * resolved Promise so callers can `await` or chain `.then`. Errors are
 * captured on `error` (no need to try/catch unless you specifically want
 * to). For tight latest-wins / serial concurrency semantics, the
 * underlying `Mutation` was already configured in the controller; the hook
 * is a pure subscription layer.
 *
 * `onSuccess` / `onError` / `onSettled` callbacks fire AFTER the run
 * resolves; they fire from the React layer, NOT the controller, so don't
 * use them for cache writes — put cache work on the mutation's spec
 * (`onSuccess`/`onError` there are the real lifecycle hooks).
 */
export function useMutation<V, R>(
  mutation: Mutation<V, R>,
  callbacks?: {
    onSuccess?: (data: R, variables: V) => void
    onError?: (error: unknown, variables: V) => void
    onSettled?: (data: R | undefined, error: unknown | undefined, variables: V) => void
  },
): {
  data: R | undefined
  error: unknown | undefined
  isPending: boolean
  lastVariables: V | undefined
  isIdle: boolean
  isSuccess: boolean
  isError: boolean
  mutate: (vars: V) => Promise<R>
  mutateAsync: (vars: V) => Promise<R>
  reset: () => void
} {
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

  const mutate = useCallback(
    (vars: V): Promise<R> => {
      const p = (mutation.run as (vars: V) => Promise<R>)(vars)
      p.then(
        (data) => {
          cbRef.current?.onSuccess?.(data, vars)
          cbRef.current?.onSettled?.(data, undefined, vars)
        },
        (err) => {
          cbRef.current?.onError?.(err, vars)
          cbRef.current?.onSettled?.(undefined, err, vars)
        },
      )
      return p
    },
    [mutation],
  )

  // Derive from the core `status` signal, NOT from `data` — a `void` mutation
  // resolves `undefined`, so the old `data !== undefined` heuristic left
  // `isSuccess` false forever and `isIdle` true (T4.2).
  return {
    data: snap.data,
    error: snap.error,
    isPending: snap.isPending,
    lastVariables: snap.lastVariables,
    isIdle: snap.status === 'idle',
    isSuccess: snap.status === 'success',
    isError: snap.status === 'error',
    mutate,
    mutateAsync: mutate,
    reset: () => mutation.reset(),
  }
}
