import type { DevtoolsEmitter } from '../devtools'
import { dispatchError, type ErrorHandler } from '../errors'
import { batch, type Signal, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import { isAbortError } from '../utils'
import type { RetryDelay, RetryPolicy, Snapshot } from './types'

/**
 * How concurrent calls to `mutation.run(...)` interact:
 * - `parallel` (default): every call runs concurrently.
 * - `latest-wins`: a new call aborts any in-flight previous call (`AbortSignal` fires).
 * - `serial`: calls queue and run one at a time in order.
 *
 * Spec §6.3.
 */
export type MutationConcurrency = 'parallel' | 'latest-wins' | 'serial'

/**
 * The configuration object passed to `ctx.mutation(spec)`. See spec §20.5 for
 * the full lifecycle semantics. `onMutate` may return a `Snapshot` (from
 * `query.setData(...)`) to enable automatic rollback on error.
 */
export type MutationSpec<V, R> = {
  /**
   * A short human-readable name. Surfaces in the devtools mutation log so the
   * user sees `moveCard` instead of just the controller path. Strongly
   * recommended in app code; cosmetic only — no runtime semantics depend on it.
   */
  name?: string
  /** The actual write. Receives the user-supplied vars and an `AbortSignal`. */
  mutate: (vars: V, signal: AbortSignal) => Promise<R>
  /**
   * Runs before `mutate`. Return a `Snapshot` from `query.setData(...)` to
   * apply an optimistic update; the snapshot is rolled back on error.
   */
  onMutate?: (vars: V) => Snapshot | void
  onSuccess?: (result: R, vars: V) => void
  onError?: (err: unknown, vars: V, snapshot: Snapshot | undefined) => void
  onSettled?: (result: R | undefined, err: unknown | undefined, vars: V) => void
  concurrency?: MutationConcurrency
  retry?: RetryPolicy
  retryDelay?: RetryDelay
}

/**
 * A running mutation. Created via `ctx.mutation(spec)` — the controller owns
 * its lifetime. Each `run(vars)` returns a Promise; the four signals reflect
 * the last-resolved run for UI binding.
 *
 * Spec §6, §20.5.
 */
/**
 * Call signature for `mutation.run`:
 *  - When `V` is `void` → no args. (`mutation.run()`)
 *  - When `V` was not constrained (default-inferred as `unknown`) → optional
 *    arg. Lets `ctx.mutation({ mutate: async () => 1 })` call `run()` *or*
 *    `run(anything)` without a type error.
 *  - Otherwise → arg required. (`mutation.run(vars)`)
 *
 * Defined as a variadic-tuple conditional so consumers see the right shape
 * without writing `run(undefined as unknown as void)`.
 */
export type MutationRun<V, R> = (
  ...args: unknown extends V ? [V?] : [V] extends [void] ? [] : [V]
) => Promise<R>

export type Mutation<V, R> = {
  /** Trigger a run. Returns a Promise that resolves with the mutate result. */
  run: MutationRun<V, R>
  data: ReadSignal<R | undefined>
  error: ReadSignal<unknown | undefined>
  isPending: ReadSignal<boolean>
  lastVariables: ReadSignal<V | undefined>
  /** Clear `data` / `error` / `lastVariables` without aborting in-flight runs. */
  reset(): void
  /** Abort in-flight runs and tear down. Idempotent. Called by the parent controller's dispose. */
  dispose(): void
}

type RunHandle = {
  abort: AbortController
  snapshot: Snapshot | undefined
}

type SerialEntry<V, R> = {
  vars: V
  resolve: (value: R) => void
  reject: (err: unknown) => void
}

class MutationImpl<V, R> implements Mutation<V, R> {
  readonly data: Signal<R | undefined> = signal(undefined)
  readonly error: Signal<unknown | undefined> = signal(undefined)
  readonly isPending: Signal<boolean> = signal(false)
  readonly lastVariables: Signal<V | undefined> = signal(undefined)

  private inflight = new Set<RunHandle>()
  private serialQueue: Array<SerialEntry<V, R>> = []
  private serialActive = false
  private disposed = false

  constructor(
    private readonly spec: MutationSpec<V, R>,
    private readonly onError: ErrorHandler | undefined,
    private readonly controllerPath: readonly string[],
    private readonly inflightCounter?: {
      update(fn: (n: number) => number): void
    },
    private readonly devtools?: DevtoolsEmitter,
  ) {}

  private emit(event: { type: 'mutation:run'; vars: unknown }): void
  private emit(event: { type: 'mutation:success'; result: unknown }): void
  private emit(event: { type: 'mutation:error'; error: unknown }): void
  private emit(event: { type: 'mutation:rollback' }): void
  private emit(
    event:
      | { type: 'mutation:run'; vars: unknown }
      | { type: 'mutation:success'; result: unknown }
      | { type: 'mutation:error'; error: unknown }
      | { type: 'mutation:rollback' },
  ): void {
    if (this.devtools === undefined) return
    const out: Record<string, unknown> = { ...event, path: this.controllerPath }
    if (this.spec.name !== undefined) out.name = this.spec.name
    this.devtools.emit(out as Parameters<DevtoolsEmitter['emit']>[0])
  }

  // Implementation-side signature accepts an optional `vars` (defaults to
  // `undefined`) so call sites for `Mutation<void, R>` can call `.run()` with
  // no args. The public type forces the right shape per `V`.
  run = ((vars: V = undefined as V): Promise<R> => {
    if (this.disposed) {
      return Promise.reject(new Error('Mutation disposed'))
    }
    const mode = this.spec.concurrency ?? 'parallel'
    switch (mode) {
      case 'parallel':
        return this.executeRun(vars)
      case 'latest-wins':
        // Spec §6.1: rollback the superseded run's snapshot BEFORE the new
        // run's onMutate runs, so the new optimistic update doesn't stack on
        // top of the obsolete one.
        for (const handle of this.inflight) {
          handle.abort.abort()
          handle.snapshot?.rollback()
          handle.snapshot = undefined
        }
        return this.executeRun(vars)
      case 'serial':
        return this.enqueueSerial(vars)
    }
  }) as MutationRun<V, R>

  private enqueueSerial(vars: V): Promise<R> {
    if (this.serialActive) {
      return new Promise<R>((resolve, reject) => {
        this.serialQueue.push({ vars, resolve, reject })
      })
    }
    this.serialActive = true
    return this.executeRun(vars).finally(() => this.advanceSerialQueue())
  }

  private advanceSerialQueue(): void {
    const next = this.serialQueue.shift()
    if (!next) {
      this.serialActive = false
      return
    }
    this.executeRun(next.vars).then(
      (result) => {
        next.resolve(result)
        this.advanceSerialQueue()
      },
      (err) => {
        next.reject(err)
        this.advanceSerialQueue()
      },
    )
  }

  private async executeRun(vars: V): Promise<R> {
    const abort = new AbortController()
    let snapshot: Snapshot | undefined
    try {
      const raw = this.spec.onMutate?.(vars) ?? undefined
      snapshot = raw === undefined ? undefined : this.wrapSnapshot(raw)
    } catch (err) {
      dispatchError(this.onError, err, {
        kind: 'mutation',
        controllerPath: this.controllerPath,
      })
    }

    const handle: RunHandle = { abort, snapshot }
    this.inflight.add(handle)
    this.inflightCounter?.update((n) => n + 1)
    batch(() => {
      this.isPending.set(true)
      this.lastVariables.set(vars)
    })

    this.emit({ type: 'mutation:run', vars })

    try {
      const result = await raceAbort(this.runWithRetry(vars, abort.signal), abort.signal)
      if (abort.signal.aborted || this.disposed) {
        snapshot?.rollback()
        throw new DOMException('Superseded', 'AbortError')
      }
      batch(() => {
        this.data.set(result)
        this.error.set(undefined)
      })
      this.emit({ type: 'mutation:success', result })
      this.safeCall(() => this.spec.onSuccess?.(result, vars), 'mutation')
      // Commit the optimistic snapshot so `hasPendingMutations` clears on the
      // affected entry. Symmetric to the auto-rollback in the error path.
      // Spec §6.4.
      snapshot?.finalize()
      this.safeCall(() => this.spec.onSettled?.(result, undefined, vars), 'mutation')
      return result
    } catch (err) {
      if (isAbortError(err) || abort.signal.aborted) {
        snapshot?.rollback()
        // Reserve `error` signal for genuine failures.
        throw err
      }
      this.error.set(err)
      this.emit({ type: 'mutation:error', error: err })
      this.safeCall(() => this.spec.onError?.(err, vars, snapshot), 'mutation')
      // Auto-rollback after the user's onError. The wrapped snapshot is
      // single-consume, so an `onError` that already called `snapshot.rollback()`
      // turns the auto-call into a no-op. Spec §6.4.
      snapshot?.rollback()
      this.safeCall(() => this.spec.onSettled?.(undefined, err, vars), 'mutation')
      throw err
    } finally {
      this.inflight.delete(handle)
      this.inflightCounter?.update((n) => Math.max(0, n - 1))
      if (this.inflight.size === 0) {
        this.isPending.set(false)
      }
    }
  }

  // Wrap so any rollback / finalize path runs the raw operation at most
  // once. The mutation auto-finalizes on success and auto-rolls-back on
  // error; user code may also call rollback() from onError. Whichever
  // happens first wins; subsequent calls (including the auto-call) no-op.
  private wrapSnapshot(raw: Snapshot): Snapshot {
    let consumed = false
    return {
      rollback: () => {
        if (consumed) return
        consumed = true
        raw.rollback()
        this.emit({ type: 'mutation:rollback' })
      },
      finalize: () => {
        if (consumed) return
        consumed = true
        raw.finalize()
      },
    }
  }

  private async runWithRetry(vars: V, signal: AbortSignal): Promise<R> {
    const retry = this.spec.retry ?? 0
    const retryDelay = this.spec.retryDelay ?? 1000
    let attempt = 0
    while (true) {
      try {
        return await this.spec.mutate(vars, signal)
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw err
        const shouldRetry = typeof retry === 'number' ? attempt < retry : retry(attempt, err)
        if (!shouldRetry) throw err
        const delay = typeof retryDelay === 'function' ? retryDelay(attempt) : retryDelay
        await abortableSleep(delay, signal)
        attempt += 1
      }
    }
  }

  private safeCall(fn: () => void, kind: 'mutation'): void {
    try {
      fn()
    } catch (err) {
      dispatchError(this.onError, err, {
        kind,
        controllerPath: this.controllerPath,
      })
    }
  }

  reset(): void {
    if (this.disposed) return
    for (const handle of this.inflight) handle.abort.abort()
    this.serialQueue.length = 0
    batch(() => {
      this.data.set(undefined)
      this.error.set(undefined)
      this.lastVariables.set(undefined)
      this.isPending.set(false)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.inflight) handle.abort.abort()
    for (const queued of this.serialQueue) {
      queued.reject(new DOMException('Disposed', 'AbortError'))
    }
    this.serialQueue.length = 0
  }
}

export function createMutation<V, R>(
  spec: MutationSpec<V, R>,
  onError: ErrorHandler | undefined,
  controllerPath: readonly string[],
  inflightCounter?: { update(fn: (n: number) => number): void },
  devtools?: DevtoolsEmitter,
): Mutation<V, R> {
  return new MutationImpl<V, R>(spec, onError, controllerPath, inflightCounter, devtools)
}

/**
 * Race a promise against an AbortSignal. If the signal fires before the
 * promise settles, the returned promise rejects with AbortError — regardless
 * of whether the underlying promise ever resolves. Protects against
 * misbehaving mutate fns that ignore their signal.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
