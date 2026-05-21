import type { DevtoolsEmitter } from '../devtools'
import { dispatchError, type ErrorHandler } from '../errors'
import { batch, type Signal, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import { abortableSleep, isAbortError } from '../utils'
import { registerMutationById } from './plugin'
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
  /**
   * Stable identifier used by the mutation-queue plugin
   * (`@kontsedal/olas-mutation-queue`) to route persistable runs across a
   * page reload. REQUIRED when `persist: true`. Recommended even without
   * `persist` if you want devtools to group runs across mutation instances
   * — same shape as `defineQuery({ queryId })`.
   *
   * Don't auto-derive from `name` or function identity; both are fragile
   * under minification.
   */
  mutationId?: string
  /**
   * Opt this mutation into durable persistence. When `true`, the runner
   * emits `onMutationEnqueue` to plugins before the user's `mutate` runs
   * and `onMutationSettle` after retries exhaust. Requires `mutationId`.
   * SPEC §13.3.
   */
  persist?: boolean
}

/**
 * Module-scope handle for a persistable mutation. Returned by
 * `defineMutation(...)`. Pass it to `ctx.mutation(...)` (spread or as-is)
 * so per-controller lifecycle hooks (`onSuccess` / `onError` / ...) can be
 * layered on top.
 *
 * Registering at module import time means the mutation-queue plugin can
 * replay pending runs from durable storage during `init` — before any
 * controller reconstructs.
 */
export type MutationDef<V, R> = MutationSpec<V, R> & {
  readonly __olas: 'mutation'
  readonly mutationId: string
}

/**
 * Register a persistable mutation at module scope. Returns the spec
 * unchanged (with a `__olas: 'mutation'` brand) so consumers can pass it
 * to `ctx.mutation(...)`, optionally spreading per-controller hooks on
 * top:
 *
 * ```ts
 * // module-scope
 * export const createOrder = defineMutation({
 *   mutationId: 'order/create',
 *   mutate: async (vars: OrderInput, { signal }) => api.createOrder(vars, { signal }),
 * })
 *
 * // controller
 * const m = ctx.mutation({
 *   ...createOrder,
 *   onSuccess: () => toast('Order placed'),
 * })
 * ```
 *
 * The `mutate` function MUST NOT close over controller-instance state — on
 * replay there is no controller. Module-level dependencies (a shared `api`
 * client, etc.) are fine.
 */
export function defineMutation<V, R>(
  spec: MutationSpec<V, R> & { mutationId: string; persist?: boolean },
): MutationDef<V, R> {
  if (typeof spec.mutationId !== 'string' || spec.mutationId.length === 0) {
    throw new Error('[olas] defineMutation requires a non-empty `mutationId`.')
  }
  // Default `persist: true` for defined mutations — that's the whole point
  // of using the module-scope helper. Consumers who want a non-persistable
  // module-scope handle can override with `persist: false`.
  const persistSpec: MutationSpec<V, R> = { ...spec, persist: spec.persist ?? true }
  registerMutationById(spec.mutationId, {
    mutationId: spec.mutationId,
    mutate: spec.mutate as (vars: unknown, signal: AbortSignal) => Promise<unknown>,
  })
  return Object.assign(persistSpec, {
    __olas: 'mutation' as const,
    mutationId: spec.mutationId,
  })
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

/**
 * Hooks for emitting persistable-mutation lifecycle events back to the
 * `QueryClient`. Wired from `createMutation` when `spec.persist === true`.
 * Internal — not part of any public surface.
 */
export type MutationLifecycleHooks = {
  emitEnqueue(event: {
    mutationId: string
    runId: string
    variables: unknown
    attempt: number
  }): void
  emitSettle(event: {
    mutationId: string
    runId: string
    outcome: 'success' | 'error' | 'cancelled'
    error?: unknown
  }): void
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
    private readonly lifecycle?: MutationLifecycleHooks,
  ) {}

  /**
   * True iff this mutation should emit persistable-lifecycle events.
   * Validated at construction time (in `createMutation`) so any malformed
   * `persist: true`-without-`mutationId` config surfaces early.
   */
  private get isPersistable(): boolean {
    return this.spec.persist === true && this.lifecycle !== undefined
  }

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
    if (!__DEV__) return
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

    if (__DEV__) this.emit({ type: 'mutation:run', vars })

    // Persistable mutations emit an enqueue event BEFORE the user's `mutate`
    // runs. If the page reloads mid-mutation, the queue plugin replays from
    // this entry. `runId` is unique per `executeRun` invocation; retries
    // within `runWithRetry` reuse it via `attempt` bumps inside that loop.
    const runId = this.isPersistable ? makeRunId() : ''
    const mutationId = this.spec.mutationId
    if (this.isPersistable && mutationId !== undefined) {
      try {
        this.lifecycle?.emitEnqueue({ mutationId, runId, variables: vars, attempt: 0 })
      } catch (err) {
        dispatchError(this.onError, err, {
          kind: 'plugin',
          controllerPath: this.controllerPath,
        })
      }
    }

    try {
      const result = await raceAbort(this.runWithRetry(vars, abort.signal), abort.signal)
      if (abort.signal.aborted || this.disposed) {
        snapshot?.rollback()
        if (this.isPersistable && mutationId !== undefined) {
          this.safeEmitSettle({ mutationId, runId, outcome: 'cancelled' })
        }
        throw new DOMException('Superseded', 'AbortError')
      }
      batch(() => {
        this.data.set(result)
        this.error.set(undefined)
      })
      if (__DEV__) this.emit({ type: 'mutation:success', result })
      this.safeCall(() => this.spec.onSuccess?.(result, vars), 'mutation')
      // Commit the optimistic snapshot so `hasPendingMutations` clears on the
      // affected entry. Symmetric to the auto-rollback in the error path.
      // Spec §6.4.
      snapshot?.finalize()
      this.safeCall(() => this.spec.onSettled?.(result, undefined, vars), 'mutation')
      if (this.isPersistable && mutationId !== undefined) {
        this.safeEmitSettle({ mutationId, runId, outcome: 'success' })
      }
      return result
    } catch (err) {
      if (isAbortError(err) || abort.signal.aborted) {
        snapshot?.rollback()
        if (this.isPersistable && mutationId !== undefined) {
          this.safeEmitSettle({ mutationId, runId, outcome: 'cancelled' })
        }
        // Reserve `error` signal for genuine failures.
        throw err
      }
      this.error.set(err)
      if (__DEV__) this.emit({ type: 'mutation:error', error: err })
      this.safeCall(() => this.spec.onError?.(err, vars, snapshot), 'mutation')
      // Auto-rollback after the user's onError. The wrapped snapshot is
      // single-consume, so an `onError` that already called `snapshot.rollback()`
      // turns the auto-call into a no-op. Spec §6.4.
      snapshot?.rollback()
      this.safeCall(() => this.spec.onSettled?.(undefined, err, vars), 'mutation')
      if (this.isPersistable && mutationId !== undefined) {
        this.safeEmitSettle({ mutationId, runId, outcome: 'error', error: err })
      }
      throw err
    } finally {
      this.inflight.delete(handle)
      this.inflightCounter?.update((n) => Math.max(0, n - 1))
      if (this.inflight.size === 0) {
        this.isPending.set(false)
      }
    }
  }

  private safeEmitSettle(event: {
    mutationId: string
    runId: string
    outcome: 'success' | 'error' | 'cancelled'
    error?: unknown
  }): void {
    try {
      this.lifecycle?.emitSettle(event)
    } catch (err) {
      dispatchError(this.onError, err, {
        kind: 'plugin',
        controllerPath: this.controllerPath,
      })
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
        if (__DEV__) this.emit({ type: 'mutation:rollback' })
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
    // Reject queued serial runs so their awaiters don't hang — symmetric with
    // `dispose()`. Without this, callers of `mutation.run(...)` on a serial
    // mutation that get reset mid-queue wait forever.
    if (this.serialQueue.length > 0) {
      const aborted = new DOMException('Aborted', 'AbortError')
      const queue = this.serialQueue
      this.serialQueue = []
      for (const queued of queue) queued.reject(aborted)
    }
    this.serialActive = false
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
  lifecycle?: MutationLifecycleHooks,
): Mutation<V, R> {
  // Validate persistable-mutation config at construction time so misconfig
  // surfaces synchronously rather than on first `run()`.
  if (spec.persist === true) {
    if (typeof spec.mutationId !== 'string' || spec.mutationId.length === 0) {
      throw new Error(
        '[olas] ctx.mutation({ persist: true, ... }) requires a non-empty `mutationId`.',
      )
    }
  }
  return new MutationImpl<V, R>(spec, onError, controllerPath, inflightCounter, devtools, lifecycle)
}

/**
 * Generate a unique-enough run id for the persistable-mutation lifecycle.
 * Uses `crypto.randomUUID` where available (Node 19+, modern browsers),
 * with a timestamp+random fallback for older runtimes. Collisions only
 * affect dedup at the plugin layer, not correctness, so the fallback's
 * weakness is acceptable.
 */
function makeRunId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID()
  const rand = Math.random().toString(36).slice(2, 12)
  return `${Date.now().toString(36)}-${rand}`
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
