import { BRAND } from '../brand'
import type { AmbientDeps } from '../controller/types'
import { __runWithCause, type DevtoolsEmitter } from '../devtools'
import { dispatchError, type ErrorHandler } from '../errors'
import type { MutateContext, MutationEvent, MutationRef } from '../plugin/types'
import { batch, type Signal, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import { abortableSleep, isAbortError } from '../utils'
import { type RegisteredMutation, registerMutationById } from './mutation-registry'
import type { AsyncStatus, RetryDelay, RetryPolicy, Snapshot } from './types'

/**
 * Rejection from `mutation.run(...)` when the mutation was already disposed —
 * the owning controller is gone, so `mutate` was never called and **the write
 * did not happen**.
 *
 * Deliberately NOT an `AbortError`. Every other cancellation in this library
 * is one, and `isAbortError(err)` is the documented way to filter them — which
 * is exactly why an abort is the wrong shape here. A superseded or reset run is
 * work the app *chose* to drop; a run against a disposed mutation is work the
 * app asked for and silently did not get, and a blanket abort filter would hide
 * that lost write.
 *
 * Reaching this usually means a callback outlived its controller — a confirm
 * dialog answered after the panel behind it closed, a retry button in a toast
 * that outlives the view. Two fixes, in order of preference:
 *
 * 1. Own the mutation somewhere that lives as long as the interaction does.
 * 2. `createMutation(ctx, { detached: true })` — runs then survive dispose, and this
 *    error is never thrown. SPEC §6.5.
 */
export class MutationDisposedError extends Error {
  /** The mutation's `id`, when it has one. */
  readonly mutationId: string | undefined
  /** Path of the controller that owned the mutation. */
  readonly controllerPath: readonly string[]

  constructor(mutationId: string | undefined, controllerPath: readonly string[]) {
    super(
      `[olas] mutation ${mutationId ?? '(anonymous)'} at ${controllerPath.join('/') || '<root>'} ` +
        'was disposed before run() was called — the write did NOT run. Own the mutation ' +
        'somewhere that outlives the interaction, or pass `detached: true` to let runs ' +
        'survive dispose.',
    )
    this.name = 'MutationDisposedError'
    this.mutationId = mutationId
    this.controllerPath = controllerPath
  }
}

/**
 * How concurrent calls to `mutation.run(...)` interact:
 * - `parallel` (default): every call runs concurrently.
 * - `latest-wins`: a new call aborts any in-flight previous call (`AbortSignal` fires).
 * - `serial`: calls queue and run one at a time in order.
 *
 * Spec §6.1.
 */
export type MutationConcurrency = 'parallel' | 'latest-wins' | 'serial'

/**
 * The configuration object passed to `createMutation(ctx, spec)`. See spec §20.5 for
 * the full lifecycle semantics. `onMutate` may return a `Snapshot` (from
 * `query.setData(...)`) to enable automatic rollback on error.
 */
export type MutationSpec<V, R> = {
  /**
   * Stable identity. It labels the mutation in devtools and error contexts,
   * and plugins route by it (the mutation queue replays a persisted run by
   * its `id`). Optional on an inline spec; `defineMutation` requires it.
   * Write it by hand — derived names change under minification.
   */
  id?: string
  /**
   * The write. Receives the variables and a `MutateCtx`: the `AbortSignal`
   * to honor and the owning controller's `deps`.
   */
  mutate: (vars: V, ctx: MutateCtx) => Promise<R>
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
   * Per-mutation settings for plugins, typed by the plugins that augment
   * `MutationMeta` (the mutation queue adds `persist`). Core never reads it.
   */
  meta?: MutationMeta
  /**
   * Let runs outlive the controller that owns them. Default `false`.
   *
   * By default `dispose()` aborts in-flight runs, rejects queued `serial`
   * runs, and makes any later `run(...)` reject with `MutationDisposedError`.
   * That is right for a read a closing screen no longer wants. It is wrong for
   * a **write**: the request is already at the server, the user asked for it,
   * and cancelling the client half neither un-sends it nor tells anyone.
   *
   * With `detached: true`, `dispose()` stops aborting — in-flight runs finish,
   * queued `serial` runs still drain, `run(...)` still works after dispose,
   * and `onSuccess` / `onError` / `onSettled` still fire, so the invalidation
   * that usually hangs off `onSuccess` lands instead of being skipped.
   *
   * What still cancels a detached run: `reset()` and a `latest-wins`
   * supersede. Both are the app explicitly saying "drop this one"; dispose
   * only says "this screen is gone".
   *
   * **The callbacks run after the controller is torn down.** Keep them to
   * client-level work — `query.invalidate()`, a toast, a logger. Do not touch
   * signals, fields or children the controller owned; those are disposed. If
   * the whole ROOT is gone the run still completes, but its cache writes
   * no-op — the client has deregistered itself from every query.
   *
   * SPEC §6.5.
   */
  detached?: boolean
}

/**
 * Per-mutation plugin settings, carried on `MutationSpec.meta`. Empty in
 * core: plugin packages add their fields through declaration merging.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by plugin packages
export interface MutationMeta {}

/** What `mutate` receives besides the variables. */
export type MutateCtx = {
  /** Fires when the run is cancelled (supersede, `reset()`, dispose). */
  signal: AbortSignal
  /** The owning controller's `deps`; the root's `deps` on a replay. */
  deps: AmbientDeps
}

/**
 * The half of a mutation that describes the write itself, for
 * `defineMutation`: its identity, the write, and its policy. Lifecycle hooks
 * are not part of it. They belong to the controller that runs the mutation
 * and go to `createMutation(ctx, def, hooks)`.
 */
export type MutationDefinition<V, R> = Pick<
  MutationSpec<V, R>,
  'mutate' | 'concurrency' | 'retry' | 'retryDelay' | 'meta'
> & { id: string }

/** The per-owner half of a mutation: what `createMutation(ctx, def, hooks)` adds. */
export type MutationHooks<V, R> = Pick<
  MutationSpec<V, R>,
  'onMutate' | 'onSuccess' | 'onError' | 'onSettled' | 'detached'
>

/**
 * A module-scope mutation, returned by `defineMutation(...)`. Run it from a
 * controller with `createMutation(ctx, def, hooks?)`.
 */
export type MutationDef<V, R> = MutationDefinition<V, R> & {
  readonly [BRAND]: 'mutation'
}

/** True for a value returned by `defineMutation`. Internal. */
export function isMutationDef(value: unknown): value is MutationDef<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === 'mutation'
  )
}

/**
 * Define a mutation at module scope. The definition is registered by `id`,
 * so a plugin can run it with no controller present. The mutation queue
 * replays a run persisted before a reload this way.
 *
 * ```ts
 * // module scope
 * export const createOrder = defineMutation({
 *   id: 'order/create',
 *   mutate: (vars: OrderInput, { signal, deps }) => deps.api.createOrder(vars, { signal }),
 *   meta: { persist: true },
 * })
 *
 * // a controller
 * const place = createMutation(ctx, createOrder, {
 *   onSuccess: () => toast('Order placed'),
 * })
 * ```
 *
 * `mutate` must not close over controller state, because on a replay there
 * is no controller. Reach services through `deps` instead.
 */
export function defineMutation<V, R>(definition: MutationDefinition<V, R>): MutationDef<V, R> {
  if (typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new Error('[olas] defineMutation requires a non-empty `id`.')
  }
  const def = { ...definition } as MutationDef<V, R>
  // Non-enumerable, so spreading a definition into an inline spec does not
  // carry the brand along with it.
  Object.defineProperty(def, BRAND, { value: 'mutation', enumerable: false })
  registerMutationById(definition.id, {
    id: definition.id,
    definition: def as unknown as MutationDefinition<unknown, unknown>,
    mutate: definition.mutate as RegisteredMutation['mutate'],
  })
  return def
}

/**
 * Call signature for `mutation.run`:
 *  - When `V` is `void` → no args. (`mutation.run()`)
 *  - When `V` was not constrained (default-inferred as `unknown`) → optional
 *    arg. Lets `createMutation(ctx, { mutate: async () => 1 })` call `run()` *or*
 *    `run(anything)` without a type error.
 *  - Otherwise → arg required. (`mutation.run(vars)`)
 *
 * Defined as a variadic-tuple conditional so consumers see the right shape
 * without writing `run(undefined as unknown as void)`.
 */
export type MutationRun<V, R> = (
  ...args: unknown extends V ? [V?] : [V] extends [void] ? [] : [V]
) => Promise<R>

/**
 * A running mutation. Created via `createMutation(ctx, spec)` — the controller owns
 * its lifetime. Each `run(vars)` returns a Promise; the signals reflect the
 * last-resolved run for UI binding.
 *
 * Spec §6, §20.5.
 */
export type Mutation<V, R> = {
  /** Trigger a run. Returns a Promise that resolves with the mutate result. */
  run: MutationRun<V, R>
  data: ReadSignal<R | undefined>
  error: ReadSignal<unknown | undefined>
  isPending: ReadSignal<boolean>
  /**
   * Outcome of the latest run: `'idle'` (never run / reset), `'pending'`
   * (in flight), `'success'`, `'error'`. Distinct from `isPending` (which
   * stays true while ANY run is in flight, for parallel mode) and from `data`
   * — a `void` mutation still reports `status: 'success'` after it resolves.
   * A superseded `latest-wins` run does NOT flip status to `'error'`; the
   * superseder owns the final status.
   */
  status: ReadSignal<AsyncStatus>
  lastVariables: ReadSignal<V | undefined>
  /**
   * Wipe the mutation back to `'idle'` — and cancel whatever it was doing.
   * In-flight runs are aborted (their awaiters reject with an `AbortError`;
   * use `isAbortError(err)` to tell those from real failures) and queued
   * `serial` runs are rejected rather than silently dropped, so no caller of
   * `run(...)` is left hanging. Then `data` / `error` / `lastVariables` clear,
   * `status` goes `'idle'`, and `isPending` drops. Spec §6.2 lists `reset()`
   * among the abort triggers.
   *
   * The cancellation is the point: "reset" here means the UI is walking away
   * from this operation (form closed, dialog dismissed), so letting the write
   * land afterwards would be worse than dropping it.
   *
   * **Porting from react-query:** its `reset()` only detaches the observer
   * and lets an in-flight request finish. This one aborts it. Do not map an
   * rq `reset()` call onto this one without re-reading the surrounding code —
   * a request you expected to complete will not.
   */
  reset(): void
  /**
   * Abort in-flight runs and tear down. Idempotent. Called by the parent
   * controller's dispose.
   *
   * Afterwards `run(...)` rejects with `MutationDisposedError` and the write
   * does NOT happen. That rejection is deliberately not an `AbortError`, so a
   * blanket `isAbortError` filter cannot swallow a dropped write.
   *
   * `detached: true` changes all of this: in-flight runs finish, queued
   * `serial` runs drain, and `run(...)` keeps working. SPEC §6.5.
   */
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
 * How a mutation reports to the root's plugins. Wired by `createMutation`
 * (and `host.mutations.run`) only when some installed plugin observes
 * mutations. Internal — not part of any public surface.
 */
export type MutationLifecycleHooks = {
  emit(event: MutationEvent): void
  /** `wrapMutate` middleware, when any plugin installed one. */
  wrap?(context: MutateContext, next: () => Promise<unknown>): Promise<unknown>
  /** Set on runs a plugin started through `host.mutations.run`. */
  origin?: string
}

class MutationImpl<V, R> implements Mutation<V, R> {
  readonly data: Signal<R | undefined> = signal(undefined)
  readonly error: Signal<unknown | undefined> = signal(undefined)
  readonly isPending: Signal<boolean> = signal(false)
  readonly status: Signal<AsyncStatus> = signal<AsyncStatus>('idle')
  readonly lastVariables: Signal<V | undefined> = signal(undefined)

  private inflight = new Set<RunHandle>()
  private serialQueue: Array<SerialEntry<V, R>> = []
  private serialActive = false
  /**
   * Which queue the `serial` continuations belong to. `reset()` abandons the
   * active run and unlocks the queue, so the next `run(...)` opens a NEW queue
   * — and the abandoned run's continuation still fires when its abort lands.
   * Bumping this on `reset()` lets that continuation recognize itself as stale
   * and neither start a queued run nor release the lock; both would let the
   * newer queue run two mutations at once (spec §6.3).
   */
  private serialGeneration = 0
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
    private readonly deps: AmbientDeps = {},
  ) {}

  /** What plugins see of this mutation. */
  private get ref(): MutationRef {
    return { id: this.spec.id, meta: this.spec.meta ?? {} }
  }

  /** Report one step of a run to the plugins, if any observe mutations. */
  private report(
    runId: string,
    variables: unknown,
    phase: MutationEvent['phase'],
    extra?: { result?: unknown; error?: unknown },
  ): void {
    const lifecycle = this.lifecycle
    if (lifecycle === undefined) return
    const event: MutationEvent = {
      mutation: this.ref,
      runId,
      variables,
      phase,
      origin: lifecycle.origin,
      ...extra,
    }
    // The plugin set isolates each hook; a throw here is a bug in core.
    lifecycle.emit(event)
  }

  /**
   * True when teardown must be treated as a cancellation. A `detached`
   * mutation is disposed like any other — the controller drops its reference —
   * but its runs are not the controller's to cancel. SPEC §6.5.
   */
  private get cancelledByDispose(): boolean {
    return this.disposed && this.spec.detached !== true
  }

  private emit(event: { type: 'mutation:run'; vars: unknown }, causeId?: string): void
  private emit(event: { type: 'mutation:success'; result: unknown }, causeId?: string): void
  private emit(event: { type: 'mutation:error'; error: unknown }, causeId?: string): void
  private emit(event: { type: 'mutation:rollback' }, causeId?: string): void
  private emit(
    event:
      | { type: 'mutation:run'; vars: unknown }
      | { type: 'mutation:success'; result: unknown }
      | { type: 'mutation:error'; error: unknown }
      | { type: 'mutation:rollback' },
    causeId?: string,
  ): void {
    if (!__DEV__) return
    if (this.devtools === undefined) return
    const out: Record<string, unknown> = { ...event, path: this.controllerPath }
    if (this.spec.id !== undefined) out.id = this.spec.id
    // `causeId` (the run id) correlates this event with the run's optimistic
    // writes / snapshot events / settle in the devtools timeline. Empty string
    // means "no run id" (non-persistable in a prod build) — omit it.
    if (causeId !== undefined && causeId !== '') out.causeId = causeId
    this.devtools.emit(out as Parameters<DevtoolsEmitter['emit']>[0])
  }

  // Implementation-side signature accepts an optional `vars` (defaults to
  // `undefined`) so call sites for `Mutation<void, R>` can call `.run()` with
  // no args. The public type forces the right shape per `V`.
  run = ((vars: V = undefined as V): Promise<R> => {
    if (this.cancelledByDispose) {
      return Promise.reject(new MutationDisposedError(this.spec.id, this.controllerPath))
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
      // A queued run counts as in flight, so `root.waitForIdle()` waits for it
      // to start and settle rather than answering while it is still to run.
      this.inflightCounter?.update((n) => n + 1)
      return new Promise<R>((resolve, reject) => {
        this.serialQueue.push({ vars, resolve, reject })
      })
    }
    this.serialActive = true
    const generation = this.serialGeneration
    return this.executeRun(vars).finally(() => this.advanceSerialQueue(generation))
  }

  private advanceSerialQueue(generation: number): void {
    // A `reset()` while this run was in flight abandoned its queue and opened a
    // new one. This continuation speaks for the old queue: starting the next
    // entry would run it alongside the new queue's active run, and clearing
    // `serialActive` would let the next `run(...)` do the same. Neither is ours
    // to do — the newer queue's own continuations will.
    if (generation !== this.serialGeneration) return
    const next = this.serialQueue.shift()
    if (!next) {
      this.serialActive = false
      return
    }
    const started = this.executeRun(next.vars)
    // The run counted itself in its synchronous start (or its `onMutate`
    // threw); only now does it leave the queued count, so the counter never
    // dips to zero between the two.
    this.inflightCounter?.update((n) => Math.max(0, n - 1))
    started.then(
      (result) => {
        next.resolve(result)
        this.advanceSerialQueue(generation)
      },
      (err) => {
        next.reject(err)
        this.advanceSerialQueue(generation)
      },
    )
  }

  private async executeRun(vars: V): Promise<R> {
    const abort = new AbortController()
    // One id per run, generated up front so it can wrap `onMutate` (below) as
    // the devtools ambient cause AND serve as the persistable run id. Skipped
    // (empty) only in a production build of a non-persistable mutation, where
    // nothing consumes it. `crypto.randomUUID`-backed — see `makeRunId`.
    const runId = this.lifecycle !== undefined || __DEV__ ? makeRunId() : ''
    /** Set once this run's single outcome has been reported to plugins. */
    let settledOutcome = false
    let snapshot: Snapshot | undefined
    // Registered before `onMutate`, so a `dispose()`, `reset()` or
    // `latest-wins` supersede that `onMutate` itself triggers aborts this run.
    // Registered after, the abort found nothing and `mutate` ran anyway.
    const handle: RunHandle = { abort, snapshot: undefined }
    this.inflight.add(handle)
    try {
      // Run `onMutate` under this run's cause so the optimistic `setData` it
      // calls — and the `snapshot:push` / `cache:set-data` those trigger —
      // inherit `runId` as their `causeId` in the devtools timeline.
      const raw = __runWithCause(runId, () => this.spec.onMutate?.(vars)) ?? undefined
      snapshot = raw === undefined ? undefined : this.wrapSnapshot(raw, runId)
    } catch (err) {
      this.leave(handle)
      // onMutate threw — the optimistic setup failed, so running `mutate`
      // against a half-applied state is unsafe. Abort the whole run: surface
      // via the error signal, the mutation's onError/onSettled, and the
      // rejected run promise (mirrors the mutate-failure path). No snapshot
      // exists yet, so nothing to roll back; `mutate` is never called. T3.9.
      this.error.set(err)
      this.status.set('error')
      if (__DEV__) this.emit({ type: 'mutation:error', error: err }, runId)
      this.safeCall(() => this.spec.onError?.(err, vars, undefined), 'mutation')
      this.safeCall(() => this.spec.onSettled?.(undefined, err, vars), 'mutation')
      throw err
    }

    if (abort.signal.aborted) {
      // Cancelled during `onMutate`: undo its guess and never call `mutate`.
      // Plugins heard no `start`, so they hear nothing.
      snapshot?.rollback()
      this.leave(handle)
      throw new DOMException('Aborted', 'AbortError')
    }
    handle.snapshot = snapshot
    this.inflightCounter?.update((n) => n + 1)
    batch(() => {
      this.isPending.set(true)
      this.status.set('pending')
      this.lastVariables.set(vars)
    })

    if (__DEV__) this.emit({ type: 'mutation:run', vars }, runId)

    // Plugins hear about the run BEFORE `mutate` is first called — after
    // `onMutate`, so an optimistic write is already visible. If the page
    // reloads mid-run, a queue plugin replays from what it stored here. One
    // `start` per run: the retry loop in `runWithRetry` re-invokes `mutate`
    // under the same `runId` and reports nothing.
    this.report(runId, vars, 'start')

    try {
      const result = await raceAbort(this.runWithRetry(vars, abort.signal, runId), abort.signal)
      if (abort.signal.aborted || this.cancelledByDispose) {
        // Reaching here means `raceAbort` RESOLVED — the work finished, and the
        // abort landed in the gap before this continuation ran. You cannot
        // cancel what already happened, so neither of the two things a
        // cancellation normally does is correct:
        //
        // - `rollback()` would write a value we KNOW to be stale into a cache
        //   that outlives this mutation, and nothing would repair it (the
        //   `onSuccess` that usually invalidates is skipped on this path).
        //   `finalize()` commits the optimistic value instead — which is what
        //   the server now holds. A `latest-wins` supersede already consumed
        //   its snapshot back in `run()`, so this is a no-op for that case.
        // - reporting `'cancel'` tells the mutation-queue plugin to KEEP the
        //   durable entry and replay it on the next page load — a second write
        //   of a request that succeeded. It settled; say so.
        snapshot?.finalize()
        this.report(runId, vars, 'success', { result })
        settledOutcome = true
        // The caller still walked away, so the promise still reports the abort:
        // whoever awaited this run is gone, and `data` / `status` belong to the
        // superseder or to nobody.
        throw new DOMException('Superseded', 'AbortError')
      }
      batch(() => {
        this.data.set(result)
        this.error.set(undefined)
        this.status.set('success')
      })
      if (__DEV__) this.emit({ type: 'mutation:success', result }, runId)
      this.safeCall(() => this.spec.onSuccess?.(result, vars), 'mutation')
      // Commit the optimistic snapshot so `hasPendingMutations` clears on the
      // affected entry. Symmetric to the auto-rollback in the error path.
      // Spec §6.4.
      snapshot?.finalize()
      this.safeCall(() => this.spec.onSettled?.(result, undefined, vars), 'mutation')
      this.report(runId, vars, 'success', { result })
      return result
    } catch (err) {
      // Only this run's own signal makes it a cancellation. An `AbortError`
      // that `mutate` threw while the signal is live came from the work itself
      // (a request it aborted on its own), so it is a failure, as a
      // fetcher-originated abort is for a query.
      if (abort.signal.aborted || this.cancelledByDispose) {
        snapshot?.rollback()
        // The late-abort branch above already reported this run's one outcome.
        if (!settledOutcome) {
          // A non-abort error with the signal aborted means `mutate` REJECTED
          // and the abort landed in the gap before this continuation:
          // `raceAbort` rejects with an AbortError when the abort comes first.
          // The work failed, so plugins hear `'error'` — the twin of the
          // late-success branch above.
          if (isAbortError(err)) this.report(runId, vars, 'cancel')
          else this.report(runId, vars, 'error', { error: err })
        }
        // The caller walked away, so its promise reports the abort, as on the
        // late-success path. `error` / `status` belong to the superseder or to
        // nobody: reserve the `error` signal for runs someone still awaits.
        throw isAbortError(err) ? err : new DOMException('Superseded', 'AbortError')
      }
      this.error.set(err)
      this.status.set('error')
      if (__DEV__) this.emit({ type: 'mutation:error', error: err }, runId)
      this.safeCall(() => this.spec.onError?.(err, vars, snapshot), 'mutation')
      // Auto-rollback after the user's onError. The wrapped snapshot is
      // single-consume, so an `onError` that already called `snapshot.rollback()`
      // turns the auto-call into a no-op. Spec §6.4.
      snapshot?.rollback()
      this.safeCall(() => this.spec.onSettled?.(undefined, err, vars), 'mutation')
      this.report(runId, vars, 'error', { error: err })
      throw err
    } finally {
      this.inflightCounter?.update((n) => Math.max(0, n - 1))
      this.leave(handle)
    }
  }

  /** Drop a run's handle; the last one out clears `isPending`. */
  private leave(handle: RunHandle): void {
    this.inflight.delete(handle)
    if (this.inflight.size === 0) this.isPending.set(false)
  }

  // Wrap so any rollback / finalize path runs the raw operation at most
  // once. The mutation auto-finalizes on success and auto-rolls-back on
  // error; user code may also call rollback() from onError. Whichever
  // happens first wins; subsequent calls (including the auto-call) no-op.
  private wrapSnapshot(raw: Snapshot, causeId: string): Snapshot {
    let consumed = false
    return {
      rollback: () => {
        if (consumed) return
        consumed = true
        // Run the rollback under the run's cause so the `snapshot:rollback` and
        // re-broadcast `cache:set-data` it triggers inherit this run's
        // `causeId` in the devtools timeline (see `__runWithCause`).
        __runWithCause(causeId, () => raw.rollback())
        if (__DEV__) this.emit({ type: 'mutation:rollback' }, causeId)
      },
      finalize: () => {
        if (consumed) return
        consumed = true
        __runWithCause(causeId, () => raw.finalize())
      },
    }
  }

  private async runWithRetry(vars: V, signal: AbortSignal, runId: string): Promise<R> {
    const retry = this.spec.retry ?? 0
    const retryDelay = this.spec.retryDelay ?? 1000
    const wrap = this.lifecycle?.wrap
    let attempt = 0
    while (true) {
      try {
        const call = (): Promise<R> => this.spec.mutate(vars, { signal, deps: this.deps })
        if (wrap === undefined) return await call()
        return (await wrap(
          {
            mutation: this.ref,
            runId,
            variables: vars,
            signal,
            attempt,
            origin: this.lifecycle?.origin,
          },
          call,
        )) as R
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
    // A detached mutation keeps its control surface after dispose: its runs
    // outlive the controller, so `reset()` is the only way left to stop them.
    if (this.cancelledByDispose) return
    for (const handle of this.inflight) handle.abort.abort()
    // Reject queued serial runs so their awaiters don't hang — symmetric with
    // `dispose()`. Without this, callers of `mutation.run(...)` on a serial
    // mutation that get reset mid-queue wait forever.
    if (this.serialQueue.length > 0) {
      const aborted = new DOMException('Aborted', 'AbortError')
      const queue = this.serialQueue
      this.serialQueue = []
      this.inflightCounter?.update((n) => Math.max(0, n - queue.length))
      for (const queued of queue) queued.reject(aborted)
    }
    // Retire the queue the aborted run belonged to before unlocking, so its
    // continuation can't advance or unlock the queue the next `run(...)` opens.
    this.serialGeneration += 1
    this.serialActive = false
    batch(() => {
      this.data.set(undefined)
      this.error.set(undefined)
      this.lastVariables.set(undefined)
      this.isPending.set(false)
      this.status.set('idle')
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // SPEC §6.5: detached runs are not the controller's to cancel. Leave the
    // in-flight handles and the serial queue alone — they finish, settle, and
    // fire their callbacks on their own.
    if (this.spec.detached === true) return
    for (const handle of this.inflight) handle.abort.abort()
    const queued = this.serialQueue.length
    if (queued > 0) this.inflightCounter?.update((n) => Math.max(0, n - queued))
    for (const entry of this.serialQueue) {
      entry.reject(new DOMException('Disposed', 'AbortError'))
    }
    this.serialQueue.length = 0
    // The aborted runs settle as cancellations and never write `status`; a
    // disposed mutation is idle, not pending forever.
    if (this.status.peek() === 'pending') this.status.set('idle')
  }
}

export function createMutation<V, R>(
  spec: MutationSpec<V, R>,
  onError: ErrorHandler | undefined,
  controllerPath: readonly string[],
  inflightCounter?: { update(fn: (n: number) => number): void },
  devtools?: DevtoolsEmitter,
  lifecycle?: MutationLifecycleHooks,
  deps?: AmbientDeps,
): Mutation<V, R> {
  return new MutationImpl<V, R>(
    spec,
    onError,
    controllerPath,
    inflightCounter,
    devtools,
    lifecycle,
    deps,
  )
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
