/**
 * Property tests for mutation concurrency — `parallel`, `serial` and
 * `latest-wins` — through the public API: `createMutation` in an attached
 * child controller, an optimistic `setData` on a real query in `onMutate`, and
 * a `definePlugin` recorder on `onMutation`. The contract is SPEC §6.1–§6.4,
 * `.wiki/flows/mutation-concurrency.md`, `.wiki/pitfalls/latest-wins-rollback-order.md`
 * and `.wiki/pitfalls/raceabort-for-misbehaving-mutate.md`.
 *
 * Each `mutate` returns a `Controllable` the sequence settles in any order.
 * Half of them ignore their abort signal, the case `raceAbort` exists for.
 * A `tick` op drains only a few microtasks, so an abort can land in the gap
 * between `mutate` resolving and the run's continuation — the "a run that
 * already completed is never rolled back" path (§6.2).
 *
 * Nothing here predicts microtask timing. The invariants are read off what
 * the engine reports: the hooks fire right after the signal writes they
 * describe, and the run promises and plugin events carry each run's outcome.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  bindQuery,
  createMutation,
  createQuery,
  createRoot,
  defineController,
  definePlugin,
  defineQuery,
  isAbortError,
  type MutationConcurrency,
  MutationDisposedError,
  type MutationEvent,
  queryEngine,
} from '../../src'
import {
  type Controllable,
  controllable,
  flushMicrotasks,
  NUM_RUNS,
  pickFrom,
  type Tracked,
  track,
} from './helpers'

type Vars = { i: number; throwInOnMutate: boolean; optimistic: boolean; honorsAbort: boolean }

type Op =
  | { t: 'run'; throwInOnMutate: boolean; optimistic: boolean; honorsAbort: boolean }
  | { t: 'reset' }
  | { t: 'settle'; pick: number; ok: boolean }
  | { t: 'flush' }
  | { t: 'tick'; n: number }
  | { t: 'dispose' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant('run' as const),
      throwInOnMutate: fc.oneof({ weight: 5, arbitrary: fc.constant(false) }, fc.constant(true)),
      optimistic: fc.boolean(),
      honorsAbort: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ t: 'reset' as const }) },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('settle' as const),
      pick: fc.nat(),
      ok: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, fc.constant(false)),
    }),
  },
  { weight: 3, arbitrary: fc.constant({ t: 'flush' as const }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('tick' as const), n: fc.integer({ min: 1, max: 4 }) }),
  },
  { weight: 1, arbitrary: fc.constant({ t: 'dispose' as const }) },
)

const scenarioArb = fc.record({
  // 'medium' so a run averages ~20 ops; the default size averages ~6.
  ops: fc.array(opArb, { minLength: 1, maxLength: 40, size: 'medium' }),
  finalOk: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
  // Dispose before the drain (every run must settle with no mutate settled),
  // or drain first and dispose after.
  disposeFirst: fc.boolean(),
})

// Staleness never lapses, so the one fetch at bind time is the only fetch.
const target = defineQuery({
  id: 'property/mutation-target',
  key: () => ['target'],
  fetcher: async () => 0,
  staleTime: Number.POSITIVE_INFINITY,
})

type RunRec = {
  vars: Vars
  /** `reset()` count when `run()` was called. */
  epoch: number
  /** `run()` was called after dispose. */
  afterDispose: boolean
  onMutateCalled: boolean
  promise: Tracked<number>
}

type CallRec = { run: number; d: Controllable<number>; signal: AbortSignal; value: number }

type Write =
  | { kind: 'success'; value: number }
  | { kind: 'error'; error: unknown }
  | { kind: 'reset' }

type Options = {
  /**
   * Require the run promise and the plugin outcome to agree outright: a
   * rejection that is not an `AbortError` means `'error'`. Off in the gate,
   * which tolerates the one known disagreement (see the skipped property).
   */
  strictOutcome: boolean
  /**
   * Require `waitForIdle()` to resolve only once no run is in flight or
   * queued. Off in the gate, which checks that it resolves at all (see the
   * skipped property).
   */
  strictIdle: boolean
}

async function runScenario(
  mode: MutationConcurrency,
  scenario: { ops: Op[]; finalOk: boolean[]; disposeFirst: boolean },
  options: Options,
): Promise<void> {
  const runs: RunRec[] = []
  const calls: CallRec[] = []
  const writes: Write[] = []
  const violations: string[] = []
  const events: MutationEvent[] = []
  let resetEpoch = 0
  let lastRunIndex = -1
  let disposed = false

  const recorder = definePlugin({
    name: 'property-recorder',
    setup: () => ({ onMutation: (event) => events.push(event) }),
  })

  // The hooks read the mutation and the subscription through these, both set
  // during construction.
  let mRef: ReturnType<typeof makeMutation> | undefined
  let subRef: { hasPendingMutations: { peek(): boolean } } | undefined

  function makeMutation(ctx: Parameters<Parameters<typeof defineController>[0]>[0]) {
    const cache = bindQuery(ctx, target)
    const settledRun = (i: number, what: string): void => {
      const run = runs[i] as RunRec
      if (disposed) violations.push(`run ${i} ${what} after dispose`)
      if (run.epoch !== resetEpoch) violations.push(`run ${i} ${what} after a reset aborted it`)
      if (mode === 'latest-wins' && i !== lastRunIndex) {
        violations.push(`run ${i} ${what}, but run ${lastRunIndex} superseded it`)
      }
    }
    return createMutation(ctx, {
      id: 'property/mutation',
      concurrency: mode,
      retry: 0,
      mutate: (vars: Vars, { signal }) => {
        if (mode === 'serial') {
          const live = calls.filter((c) => !c.d.settled && !c.signal.aborted)
          if (live.length > 0) {
            violations.push(`serial: mutate(${vars.i}) while ${live.map((c) => c.run)} in flight`)
          }
        }
        const d = controllable<number>(signal, vars.honorsAbort)
        calls.push({ run: vars.i, d, signal, value: 7_000_000 + calls.length })
        return d.promise
      },
      onMutate: (vars) => {
        ;(runs[vars.i] as RunRec).onMutateCalled = true
        // §6.1: the superseded run's snapshot is rolled back BEFORE this runs.
        if (mode === 'latest-wins' && subRef?.hasPendingMutations.peek()) {
          violations.push(`latest-wins: onMutate(${vars.i}) saw a live superseded snapshot`)
        }
        if (vars.throwInOnMutate) throw new Error(`onMutate ${vars.i} threw`)
        if (vars.optimistic) return cache.setData((prev) => (prev ?? 0) + 1)
        return undefined
      },
      onSuccess: (result, vars) => {
        settledRun(vars.i, 'succeeded')
        const call = calls.find((c) => c.run === vars.i)
        if (call?.value !== result) violations.push(`run ${vars.i} resolved another run's value`)
        const m = mRef!
        if (m.data.peek() !== result || m.status.peek() !== 'success') {
          violations.push(`run ${vars.i}: onSuccess before data/status were written`)
        }
        writes.push({ kind: 'success', value: result })
      },
      onError: (error, vars) => {
        settledRun(vars.i, 'failed')
        const m = mRef!
        if (m.error.peek() !== error || m.status.peek() !== 'error') {
          violations.push(`run ${vars.i}: onError before error/status were written`)
        }
        writes.push({ kind: 'error', error })
      },
    })
  }

  const child = defineController((ctx) => {
    const m = makeMutation(ctx)
    mRef = m
    return { m }
  })
  const app = defineController((ctx) => {
    const sub = createQuery(ctx, target)
    subRef = sub
    const attached = ctx.attach(child, undefined)
    return { sub, attached }
  })
  const root = createRoot(app, { queries: queryEngine(), deps: {}, plugins: [recorder] })
  const { sub, attached } = root.api
  const m = attached.api.m
  await flushMicrotasks() // the bind-time fetch lands: data 0
  expect(sub.data.peek()).toBe(0)

  const dispose = (): void => {
    attached.dispose()
    disposed = true
  }

  const settle = (c: CallRec, ok: boolean): void => {
    if (ok) c.d.resolve(c.value)
    else c.d.reject(new Error(`mutate ${c.run} failed`))
  }

  for (const [n, op] of scenario.ops.entries()) {
    switch (op.t) {
      case 'run': {
        const i = runs.length
        const vars: Vars = {
          i,
          throwInOnMutate: op.throwInOnMutate,
          optimistic: op.optimistic,
          honorsAbort: op.honorsAbort,
        }
        const rec: RunRec = {
          vars,
          epoch: resetEpoch,
          afterDispose: disposed,
          onMutateCalled: false,
          promise: { state: 'pending' },
        }
        runs.push(rec)
        if (!disposed) lastRunIndex = i
        rec.promise = track(m.run(vars))
        break
      }
      case 'reset':
        m.reset()
        // A disposed (non-detached) mutation ignores reset.
        if (!disposed) {
          resetEpoch += 1
          writes.push({ kind: 'reset' })
        }
        break
      case 'settle': {
        const c = pickFrom(
          calls.filter((x) => !x.d.settled),
          op.pick,
        )
        if (c !== undefined) settle(c, op.ok)
        break
      }
      case 'flush':
        await flushMicrotasks()
        break
      case 'tick':
        for (let k = 0; k < op.n; k++) await Promise.resolve()
        break
      case 'dispose':
        if (!disposed) dispose()
        break
    }
    expect(violations, `op #${n} ${JSON.stringify(op)}`).toEqual([])
  }

  // waitForIdle, asked before the drain, must not answer while a run is
  // still in flight or queued behind a serial one.
  let idleEarly: string | undefined
  const idle = track(
    root.waitForIdle().then(() => {
      const open = runs.filter((r) => r.promise.state === 'pending' && r.onMutateCalled === false)
      if (m.isPending.peek()) idleEarly = 'isPending still true'
      else if (!disposed && open.length > 0) {
        idleEarly = `runs ${open.map((r) => r.vars.i)} still queued`
      }
    }),
  )

  if (scenario.disposeFirst && !disposed) {
    // Dispose alone must settle every run: nothing below settles a mutate.
    dispose()
    await flushMicrotasks()
    for (const [i, r] of runs.entries()) {
      expect(r.promise.state, `run ${i} after dispose`).not.toBe('pending')
    }
  }

  for (let round = 0; round < 50; round++) {
    await flushMicrotasks()
    const open = calls.filter((c) => !c.d.settled)
    if (open.length === 0) break
    open.forEach((c, k) => {
      settle(c, scenario.finalOk[(round + k) % scenario.finalOk.length] as boolean)
    })
  }
  await flushMicrotasks()
  expect(
    calls.every((c) => c.d.settled),
    'drain did not quiesce',
  ).toBe(true)
  expect(violations).toEqual([])

  // Every run() settled; isPending dropped; waitForIdle answered, and not early.
  for (const [i, r] of runs.entries()) {
    expect(r.promise.state, `run ${i} promise`).not.toBe('pending')
  }
  expect(m.isPending.peek()).toBe(false)
  expect(idle.state).toBe('fulfilled')
  if (options.strictIdle) expect(idleEarly).toBeUndefined()

  // Plugins see exactly one outcome per start, and it agrees with the run.
  const byRun = new Map<number, MutationEvent[]>()
  const runIds = new Map<string, number>()
  for (const e of events) {
    const i = (e.variables as Vars).i
    const known = runIds.get(e.runId)
    if (known === undefined) runIds.set(e.runId, i)
    else expect(known, 'one runId per run').toBe(i)
    byRun.set(i, [...(byRun.get(i) ?? []), e])
  }
  expect(runIds.size, 'one runId per run').toBe(byRun.size)
  let optimisticCommitted = false
  for (const [i, r] of runs.entries()) {
    const phases = (byRun.get(i) ?? []).map((e) => e.phase)
    if (!r.onMutateCalled || r.vars.throwInOnMutate) {
      // Never reached `mutate`: rejected after dispose, dropped from a serial
      // queue by reset/dispose, or its onMutate threw. No plugin events.
      expect(phases, `run ${i} never started`).toEqual([])
      expect(r.promise.state, `run ${i}`).toBe('rejected')
      if (r.afterDispose) expect(r.promise.error).toBeInstanceOf(MutationDisposedError)
      else if (!r.onMutateCalled) expect(isAbortError(r.promise.error), `run ${i}`).toBe(true)
      else expect((r.promise.error as Error).message).toBe(`onMutate ${i} threw`)
      continue
    }
    expect(phases.length, `run ${i} phases ${phases}`).toBe(2)
    expect(phases[0]).toBe('start')
    const outcome = phases[1]
    if (r.promise.state === 'fulfilled') {
      expect(outcome, `run ${i}`).toBe('success')
    } else if (isAbortError(r.promise.error)) {
      // Cancelled, or settled in the gap before its continuation (§6.2): then
      // plugins hear what `mutate` really did, and the caller the abort.
      expect(['cancel', 'success', 'error'], `run ${i}`).toContain(outcome)
      const settlement = calls.find((c) => c.run === i)?.d.settlement
      if (outcome === 'success') expect(settlement?.ok, `run ${i} mutate`).toBe(true)
      if (outcome === 'error') expect(settlement?.ok, `run ${i} mutate`).toBe(false)
    } else {
      expect(outcome, `run ${i}`).toBe('error')
    }
    if (r.vars.optimistic && outcome === 'success') optimisticCommitted = true
  }

  // Every optimistic layer was settled; if none committed, the chain unwound
  // to the pre-mutation value whatever the order (§6.4).
  expect(sub.hasPendingMutations.peek()).toBe(false)
  if (!optimisticCommitted) expect(sub.data.peek()).toBe(0)

  // data/status/error are the last write a hook reported (latest-wins: of the
  // latest run). A disposed mutation keeps whatever the aborted run left.
  if (!disposed) {
    let data: number | undefined
    let error: unknown
    let status = 'idle'
    for (const w of writes) {
      if (w.kind === 'success') {
        data = w.value
        error = undefined
        status = 'success'
      } else if (w.kind === 'error') {
        error = w.error
        status = 'error'
      } else {
        data = undefined
        error = undefined
        status = 'idle'
      }
    }
    expect({ data: m.data.peek(), error: m.error.peek(), status: m.status.peek() }).toEqual({
      data,
      error,
      status,
    })
  }

  root.dispose()
}

describe('mutation concurrency — property', () => {
  for (const mode of ['parallel', 'serial', 'latest-wins'] as const) {
    test(`${mode}: every run settles once, plugins see one outcome per start, state is the last write`, async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, (scenario) =>
          runScenario(mode, scenario, { strictOutcome: true, strictIdle: true }),
        ),
        { numRuns: NUM_RUNS },
      )
    })
  }
})
