/**
 * Property tests for `Entry<T>` — race protection, cancel, hydration and the
 * optimistic snapshot chain. The contract is `.wiki/entities/entry.md` and
 * SPEC §5.5, §5.6, §6.4.
 *
 * Each run drives one `Entry` through a random op sequence while a spec-level
 * model predicts every public signal. Fetchers return `Controllable`s that the
 * sequence settles in any order, with a value, an error, or a self-inflicted
 * `AbortError`, so the ordering between a fetch landing and the ops around it
 * is chosen by the generator. An op sequence is a plain array rather than
 * `fc.commands` on purpose: nothing awaits between two ops, so a microtask
 * continuation only runs at an explicit `flush`. That keeps "settle, then
 * supersede before the continuation runs" reachable and the model exact.
 *
 * Writes come in two shapes: a whole value, and a patch that reads `prev`. A
 * canonical patch is re-run on every live baseline, and a committed layer is
 * re-run on the baselines below it unless a server read landed since it was
 * pushed (SPEC §6.4). A rollback below the top replays the layers above it
 * over the baseline it restored. A patch adds a large, distinct amount, so
 * every value the orders of application could produce stays apart from a
 * fetch's value.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { Entry } from '../../src/query/entry'
import type { AsyncStatus, Snapshot } from '../../src/query/types'
import {
  type Controllable,
  controllable,
  flushMicrotasks,
  NUM_RUNS,
  PROPERTY_TIMEOUT,
  pickFrom,
  type Tracked,
  track,
} from './helpers'

type Outcome = 'resolve' | 'reject' | 'abort'

type Op =
  | { t: 'start'; via: 'startFetch' | 'refetch' | 'invalidate'; honorsAbort: boolean }
  | { t: 'settle'; pick: number; outcome: Outcome; current: boolean }
  | { t: 'flush' }
  | { t: 'cancel' }
  | { t: 'reset' }
  | { t: 'setTracked'; patch: boolean }
  | { t: 'setCanonical'; patch: boolean; whole: boolean }
  | { t: 'rollback'; pick: number }
  | { t: 'finalize'; pick: number }
  | { t: 'hydrate' }

// Mostly successes, so data actually moves; failures and self-aborts stay common.
const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  { weight: 3, arbitrary: fc.constant('resolve' as const) },
  { weight: 1, arbitrary: fc.constant('reject' as const) },
  { weight: 1, arbitrary: fc.constant('abort' as const) },
)

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('start' as const),
      via: fc.constantFrom('startFetch' as const, 'refetch' as const, 'invalidate' as const),
      honorsAbort: fc.boolean(),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant('settle' as const),
      pick: fc.nat(),
      outcome: outcomeArb,
      // Aim at the current fetch, or at any open one (mostly superseded ones).
      current: fc.boolean(),
    }),
  },
  { weight: 4, arbitrary: fc.constant({ t: 'flush' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'cancel' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'reset' as const }) },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('setTracked' as const), patch: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('setCanonical' as const),
      patch: fc.boolean(),
      whole: fc.boolean(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('rollback' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('finalize' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ t: 'hydrate' as const }) },
)

const scenarioArb = fc.record({
  // 'medium' so a run averages ~20 ops; the default size averages ~6.
  ops: fc.array(opArb, { minLength: 1, maxLength: 40, size: 'medium' }),
  // How the final drain settles whatever is still open.
  finalOutcomes: fc.array(outcomeArb, { minLength: 1, maxLength: 4 }),
  // The order the surviving snapshots are rolled back in at the end.
  rollbackOrder: fc.array(fc.nat(), { minLength: 1, maxLength: 8 }),
})

type FetchRec = {
  id: number
  d: Controllable<number>
  /** The value this fetch resolves with, unique across the run. */
  value: number
  /** A later fetch, `cancel` or hydration took the entry from this fetch. */
  superseded: boolean
  /** Its continuation has run (it settled and a flush followed). */
  applied: boolean
  promise: Tracked<number>
}

type Updater = (prev: number | undefined) => number

/**
 * One live optimistic layer, as SPEC §6.4 describes it: a baseline, not a delta,
 * plus the updater a commit re-runs and the server reads it was pushed after.
 */
type Layer = { snap: Snapshot; baseline: number | undefined; updater: Updater; epoch: number }

type Model = {
  data: number | undefined
  status: AsyncStatus
  error: unknown
  isLoading: boolean
  current: FetchRec | null
  layers: Layer[]
  /** Server reads (fetch successes, hydrated rows) so far. */
  epoch: number
}

type Options = {
  /**
   * Allow `applyHydration` while snapshots are live and expect it to rebase
   * them as fetch success does. Off in the gated property.
   */
  hydrateRebases: boolean
}

async function runScenario(
  scenario: { ops: Op[]; finalOutcomes: Outcome[]; rollbackOrder: number[] },
  options: Options,
): Promise<void> {
  let lastDeferred: Controllable<number> | null = null
  let honorsNext = false
  const entry = new Entry<number>({
    fetcher: () => (signal) => {
      const d = controllable<number>(signal, honorsNext)
      lastDeferred = d
      return d.promise
    },
    retry: 0,
  })
  const model: Model = {
    data: undefined,
    status: 'idle',
    error: undefined,
    isLoading: false,
    current: null,
    layers: [],
    epoch: 0,
  }
  const fetches: FetchRec[] = []
  const snaps: Layer[] = []
  const supersededValues = new Set<number>()
  let seq = 0

  const supersede = (f: FetchRec): void => {
    f.superseded = true
    supersededValues.add(f.value)
  }

  const settledStatus = (): AsyncStatus => (model.data !== undefined ? 'success' : 'idle')

  const writeStatus = (): void => {
    if (model.status === 'idle' || model.status === 'pending') model.status = 'success'
  }

  const modelRollback = (layer: Layer): void => {
    const i = model.layers.indexOf(layer)
    if (i === -1) return // already settled: rollback is a no-op
    if (i === model.layers.length - 1) model.data = layer.baseline
    else (model.layers[i + 1] as Layer).baseline = layer.baseline
    model.layers.splice(i, 1)
    if (i < model.layers.length) replay(i)
  }

  /**
   * The layers from `from` up lost a layer under them (§6.4): each baseline is
   * the one below with that layer's updater applied, and the data is the top's
   * result. A layer a server read replaced passes its baseline through.
   */
  const replay = (from: number): void => {
    let v = (model.layers[from] as Layer).baseline
    for (let j = from; j < model.layers.length; j++) {
      const l = model.layers[j] as Layer
      if (j > from) l.baseline = v
      if (l.epoch === model.epoch) v = l.updater(v)
    }
    model.data = v
  }

  const modelFinalize = (layer: Layer): void => {
    const i = model.layers.indexOf(layer)
    if (i === -1) return
    // A commit folds into the baselines below it, unless a server read landed
    // since the layer was pushed (§6.4).
    if (layer.epoch === model.epoch) {
      for (const l of model.layers.slice(0, i)) l.baseline = layer.updater(l.baseline)
    }
    model.layers.splice(i, 1)
  }

  /** A write's updater: a whole value, or a patch that adds to `prev`. */
  const writer = (base: number, patch: boolean): Updater => {
    const v = base + seq++
    return patch ? (prev) => (prev ?? 0) + v * 10 : () => v
  }

  const settle = (f: FetchRec, outcome: Outcome): void => {
    if (outcome === 'resolve') f.d.resolve(f.value)
    else if (outcome === 'reject') f.d.reject(new Error(`fetch ${f.id} failed`))
    else f.d.reject(new DOMException(`fetch ${f.id} aborted itself`, 'AbortError'))
  }

  /** Drain microtasks, then apply every continuation that just ran to the model. */
  const flush = async (): Promise<void> => {
    await flushMicrotasks()
    for (const f of fetches) {
      if (f.applied || !f.d.settled) continue
      f.applied = true
      if (f !== model.current) continue // superseded: writes nothing (SPEC §5.6)
      model.current = null
      model.isLoading = false
      const s = f.d.settlement!
      if (s.ok) {
        model.data = s.value
        model.error = undefined
        model.status = 'success'
        // Fetch success rebases every live snapshot onto server truth (§6.4).
        for (const l of model.layers) l.baseline = s.value
        model.epoch += 1
      } else {
        model.error = s.error
        model.status = 'error'
      }
    }
  }

  const check = (where: string): void => {
    const state = {
      data: entry.data.peek(),
      status: entry.status.peek(),
      error: entry.error.peek(),
      isFetching: entry.isFetching.peek(),
      isLoading: entry.isLoading.peek(),
      hasPendingMutations: entry.hasPendingMutations.peek(),
    }
    expect(state, where).toEqual({
      data: model.data,
      status: model.status,
      error: model.error,
      isFetching: model.current !== null,
      isLoading: model.isLoading,
      hasPendingMutations: model.layers.length > 0,
    })
    if (state.data !== undefined) {
      expect(supersededValues.has(state.data), `${where}: a superseded fetch wrote`).toBe(false)
    }
  }

  for (const [n, op] of scenario.ops.entries()) {
    const where = `op #${n} ${JSON.stringify(op)}`
    switch (op.t) {
      case 'start': {
        honorsNext = op.honorsAbort
        lastDeferred = null
        const p =
          op.via === 'startFetch'
            ? entry.startFetch()
            : op.via === 'refetch'
              ? entry.refetch()
              : entry.invalidate()
        // The fetcher runs synchronously inside startFetch.
        expect(lastDeferred, `${where}: fetcher not called`).not.toBeNull()
        const id = fetches.length
        const rec: FetchRec = {
          id,
          d: lastDeferred as unknown as Controllable<number>,
          value: 3_000_000 + id,
          superseded: false,
          applied: false,
          promise: track(p),
        }
        fetches.push(rec)
        if (model.current !== null) supersede(model.current)
        model.current = rec
        model.status = 'pending'
        model.isLoading = model.data === undefined
        break
      }
      case 'settle': {
        const cur = model.current
        const pool = op.current && cur !== null ? [cur] : fetches
        const f = pickFrom(
          pool.filter((x) => !x.d.settled),
          op.pick,
        )
        if (f !== undefined) settle(f, op.outcome)
        break
      }
      case 'flush':
        await flush()
        break
      case 'cancel':
        entry.cancel()
        if (model.current !== null) {
          supersede(model.current)
          model.current = null
          model.isLoading = false
          model.status = settledStatus()
        }
        break
      case 'reset':
        entry.reset()
        model.error = undefined
        model.status = settledStatus()
        break
      case 'setTracked': {
        const updater = writer(1_000_000, op.patch)
        const layer: Layer = {
          snap: { rollback() {}, finalize() {} },
          baseline: model.data,
          updater,
          epoch: model.epoch,
        }
        layer.snap = entry.setData(updater)
        model.layers.push(layer)
        snaps.push(layer)
        model.data = updater(model.data)
        writeStatus()
        break
      }
      case 'setCanonical': {
        const updater = writer(2_000_000, op.patch)
        // `whole` is how a `replace` writes: its value becomes every baseline.
        // Only an updater that ignores `prev` can be one.
        const whole = op.whole && !op.patch
        entry.setData(updater, { track: false, whole })
        const next = updater(model.data)
        model.data = next
        // A canonical write patches every live baseline (§6.4); a whole value
        // becomes each one.
        for (const l of model.layers) l.baseline = whole ? next : updater(l.baseline)
        writeStatus()
        break
      }
      case 'rollback': {
        const layer = pickFrom(snaps, op.pick)
        if (layer === undefined) break
        layer.snap.rollback()
        modelRollback(layer)
        break
      }
      case 'finalize': {
        const layer = pickFrom(snaps, op.pick)
        if (layer === undefined) break
        layer.snap.finalize()
        modelFinalize(layer)
        break
      }
      case 'hydrate': {
        // The gated property keeps hydration off live snapshots: whether it
        // rebases them is a separate property (below).
        if (!options.hydrateRebases && model.layers.length > 0) break
        const v = 4_000_000 + seq++
        entry.applyHydration(v, Date.now())
        if (model.current !== null) supersede(model.current)
        model.current = null
        model.data = v
        model.error = undefined
        model.status = 'success'
        model.isLoading = false
        for (const l of model.layers) l.baseline = v
        model.epoch += 1
        break
      }
    }
    check(where)
  }

  // Settle everything still open, in the generated outcome mix, until quiet.
  for (let round = 0; round < 10; round++) {
    const open = fetches.filter((f) => !f.d.settled)
    if (open.length === 0) break
    open.forEach((f, i) => {
      settle(f, scenario.finalOutcomes[(round + i) % scenario.finalOutcomes.length] as Outcome)
    })
    await flush()
    check(`final drain round ${round}`)
  }
  // Continuations of fetches settled by the last ops, before any drain round.
  await flush()
  check('final drain')

  // Nothing left in flight, and no status wedged at 'pending'.
  expect(entry.isFetching.peek()).toBe(false)
  expect(entry.status.peek()).not.toBe('pending')

  // Every fetch promise settled; a superseded one rejects, the rest report their own outcome.
  for (const f of fetches) {
    expect(f.promise.state, `fetch ${f.id} promise`).not.toBe('pending')
    if (f.superseded) {
      expect(f.promise.state, `superseded fetch ${f.id}`).toBe('rejected')
      continue
    }
    const s = f.d.settlement!
    if (s.ok) {
      expect(f.promise.state).toBe('fulfilled')
      expect(f.promise.value).toBe(s.value)
    } else {
      expect(f.promise.state).toBe('rejected')
      expect(f.promise.error).toBe(s.error)
    }
  }

  // Roll back every live snapshot in the generated order: data lands on the
  // bottom layer's baseline — the value canonical before the layers were pushed.
  const expected = model.layers.length > 0 ? (model.layers[0] as Layer).baseline : model.data
  let j = 0
  while (model.layers.length > 0) {
    const pick = scenario.rollbackOrder[j++ % scenario.rollbackOrder.length] as number
    const layer = model.layers[pick % model.layers.length] as Layer
    layer.snap.rollback()
    modelRollback(layer)
    check(`final rollback #${j}`)
  }
  expect(entry.data.peek()).toBe(expected)
  expect(entry.hasPendingMutations.peek()).toBe(false)
  entry.dispose()
}

describe('Entry — property', () => {
  test(
    'fetch race, cancel, hydration and the snapshot chain match the model',
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, (scenario) =>
          runScenario(scenario, { hydrateRebases: true }),
        ),
        { numRuns: NUM_RUNS },
      )
    },
    PROPERTY_TIMEOUT,
  )
})
