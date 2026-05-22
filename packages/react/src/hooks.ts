import type { AsyncState, AsyncStatus, Field, Mutation, ReadSignal } from '@kontsedal/olas-core'
import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * Wrap a signal subscribe so the synchronous "initial-value" call that
 * `@preact/signals-core` (and Olas signals) fire on `subscribe(handler)` does
 * NOT translate into a React store-change notification. React already gets
 * the initial value through `getSnapshot()`; routing it through subscribe
 * would just cause spurious work — and in some setups (e.g. RTL's act-less
 * renders) confuse useSyncExternalStore's tear-detection.
 */
function subscribeOnChange<T>(s: ReadSignal<T>, onChange: () => void): () => void {
  let initial = true
  return s.subscribe(() => {
    if (initial) {
      initial = false
      return
    }
    onChange()
  })
}

/**
 * Subscribe to a single read-signal and return its current value.
 *
 * Built on `useSyncExternalStore` — concurrent-safe, no tearing. Use this
 * when a component depends on one signal; for `Field<T>` and `AsyncState<T>`,
 * prefer `useField` and `useQuery` which batch multiple subscribes into one
 * render trigger.
 */
export function use<T>(signal: ReadSignal<T>): T {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeOnChange(signal, onChange),
    [signal],
  )
  const getSnapshot = useCallback(() => signal.peek(), [signal])
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
  const versionRef = useRef(0)

  const subscribe = useCallback(
    (onChange: () => void) => {
      const bump = () => {
        versionRef.current++
        onChange()
      }
      const unsubs = [
        subscribeOnChange(subscription.data, bump),
        subscribeOnChange(subscription.error, bump),
        subscribeOnChange(subscription.status, bump),
        subscribeOnChange(subscription.isLoading, bump),
        subscribeOnChange(subscription.isFetching, bump),
        subscribeOnChange(subscription.isStale, bump),
        subscribeOnChange(subscription.lastUpdatedAt, bump),
        subscribeOnChange(subscription.hasPendingMutations, bump),
      ]
      return () => {
        for (const u of unsubs) u()
      }
    },
    [subscription],
  )
  const getSnapshot = useCallback(() => versionRef.current, [])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (options?.suspense === true) {
    const status = subscription.status.peek()
    const data = subscription.data.peek()
    // Error first — Suspense will not catch this, ErrorBoundary will.
    if (status === 'error') {
      throw subscription.error.peek()
    }
    // First-load suspend: only when we genuinely have no data yet. After
    // a successful settle, refetches keep `data` defined and the hook
    // returns normally (matches TanStack Query's `suspense` semantics).
    if (data === undefined && (status === 'pending' || status === 'idle')) {
      throw subscription.promise()
    }
  }

  return {
    data: subscription.data.peek(),
    error: subscription.error.peek(),
    status: subscription.status.peek(),
    isLoading: subscription.isLoading.peek(),
    isFetching: subscription.isFetching.peek(),
    isStale: subscription.isStale.peek(),
    lastUpdatedAt: subscription.lastUpdatedAt.peek(),
    hasPendingMutations: subscription.hasPendingMutations.peek(),
    refetch: subscription.refetch,
  }
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
  const versionRef = useRef(0)

  const subscribe = useCallback(
    (onChange: () => void) => {
      const bump = () => {
        versionRef.current++
        onChange()
      }
      const unsubs = [
        subscribeOnChange(field, bump),
        subscribeOnChange(field.errors, bump),
        subscribeOnChange(field.isValid, bump),
        subscribeOnChange(field.isDirty, bump),
        subscribeOnChange(field.touched, bump),
        subscribeOnChange(field.isValidating, bump),
      ]
      return () => {
        for (const u of unsubs) u()
      }
    },
    [field],
  )
  const getSnapshot = useCallback(() => versionRef.current, [])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    value: field.peek(),
    errors: field.errors.peek(),
    isValid: field.isValid.peek(),
    isDirty: field.isDirty.peek(),
    touched: field.touched.peek(),
    isValidating: field.isValidating.peek(),
    set: (next: T) => field.set(next),
    reset: () => field.reset(),
    markTouched: () => field.markTouched(),
    revalidate: () => field.revalidate(),
    setErrors: (errs: ReadonlyArray<string>) => field.setErrors(errs),
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
  const versionRef = useRef(0)
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks

  const subscribe = useCallback(
    (onChange: () => void) => {
      const bump = () => {
        versionRef.current++
        onChange()
      }
      const unsubs = [
        subscribeOnChange(mutation.data, bump),
        subscribeOnChange(mutation.error, bump),
        subscribeOnChange(mutation.isPending, bump),
        subscribeOnChange(mutation.lastVariables, bump),
      ]
      return () => {
        for (const u of unsubs) u()
      }
    },
    [mutation],
  )
  const getSnapshot = useCallback(() => versionRef.current, [])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

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

  const status =
    mutation.error.peek() !== undefined
      ? 'error'
      : mutation.data.peek() !== undefined
        ? 'success'
        : 'idle'

  return {
    data: mutation.data.peek(),
    error: mutation.error.peek(),
    isPending: mutation.isPending.peek(),
    lastVariables: mutation.lastVariables.peek(),
    isIdle: status === 'idle' && !mutation.isPending.peek(),
    isSuccess: status === 'success',
    isError: status === 'error',
    mutate,
    mutateAsync: mutate,
    reset: () => mutation.reset(),
  }
}
