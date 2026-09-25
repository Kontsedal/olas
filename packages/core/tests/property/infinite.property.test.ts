/**
 * Property tests for `InfiniteEntry` — page-fetch race protection, cancel,
 * hydration, and the pages/pageParams snapshot chain. The contract is
 * `.wiki/entities/entry.md` (the `InfiniteEntry` paragraphs),
 * `.wiki/decisions/infinite-query-parity.md`,
 * `.wiki/decisions/canonical-vs-optimistic-writes.md` and SPEC §5.11, §6.4.
 *
 * The model is observational where the engine's page bookkeeping would have to
 * be re-implemented, and exact where the contract is a single sentence:
 *
 * - An op is one request (`startFetch`, `fetchNextPage`, `fetchPreviousPage`).
 *   The fetcher runs synchronously inside the call, so a call that reaches the
 *   fetcher started an op and superseded the one before it. Ops are told apart
 *   by their `AbortSignal`: every page of one refetch shares it.
 * - A superseded op's pages never reach `pages`, and it never fetches again.
 * - `isFetching` is true exactly while an op is current.
 * - `pages.length === pageParams.length`, after every op.
 * - Rolling back every live snapshot, in any order, restores the pages and
 *   params the bottom layer captured. A canonical patch is re-run on every
 *   live baseline, a `replace` (`whole`) becomes each one, and a committed
 *   layer is re-run on the baselines below it unless a server read landed
 *   since it was pushed (SPEC §6.4). A page fetch's rebase is not modelled, so
 *   the check is made only in stretches where no fetch success landed over
 *   live snapshots.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { InfiniteEntry } from '../../src/query/infinite'
import type { Snapshot } from '../../src/query/types'
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

type Page = { p: number; v: number }

const MIN_PARAM = -2
const MAX_PARAM = 3

type Outcome = 'resolve' | 'reject' | 'abort'
type Shape = 'append' | 'prepend' | 'dropLast' | 'dropFirst' | 'clear' | 'replace2'
type ParamsMode = 'none' | 'match' | 'mismatch'

type Op =
  | { t: 'start'; via: 'startFetch' | 'refetch' | 'invalidate'; honorsAbort: boolean }
  | { t: 'next'; honorsAbort: boolean }
  | { t: 'prev'; honorsAbort: boolean }
  | { t: 'settle'; pick: number; outcome: Outcome; current: boolean }
  | { t: 'flush' }
  | { t: 'cancel' }
  | { t: 'reset' }
  | { t: 'set'; tracked: boolean; shape: Shape; params: ParamsMode; patch: boolean; whole: boolean }
  | { t: 'rollback'; pick: number }
  | { t: 'finalize'; pick: number }
  | { t: 'hydrate'; count: number }

// Mostly successes, so data actually moves; failures and self-aborts stay common.
const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  { weight: 3, arbitrary: fc.constant('resolve' as const) },
  { weight: 1, arbitrary: fc.constant('reject' as const) },
  { weight: 1, arbitrary: fc.constant('abort' as const) },
)

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('start' as const),
      via: fc.constantFrom('startFetch' as const, 'refetch' as const, 'invalidate' as const),
      honorsAbort: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('next' as const), honorsAbort: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('prev' as const), honorsAbort: fc.boolean() }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('settle' as const),
      pick: fc.nat(),
      outcome: outcomeArb,
      // Aim at the current op's open page, or at any open page (mostly superseded ones).
      current: fc.boolean(),
    }),
  },
  { weight: 4, arbitrary: fc.constant({ t: 'flush' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'cancel' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'reset' as const }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('set' as const),
      tracked: fc.boolean(),
      shape: fc.constantFrom<Shape>(
        'append',
        'prepend',
        'dropLast',
        'dropFirst',
        'clear',
        'replace2',
      ),
      params: fc.constantFrom<ParamsMode>('none', 'match', 'mismatch'),
      // An updater that reads `prev`, or the pages built up front.
      patch: fc.boolean(),
      // A canonical whole-record write, as `replace` makes one.
      whole: fc.boolean(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('rollback' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('finalize' as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('hydrate' as const),
      count: fc.integer({ min: 1, max: 3 }),
    }),
  },
)

const scenarioArb = fc.record({
  // 'medium' so a run averages ~30 ops; the default size averages ~6.
  ops: fc.array(opArb, { minLength: 1, maxLength: 60, size: 'medium' }),
  finalOutcomes: fc.array(outcomeArb, { minLength: 1, maxLength: 4 }),
  rollbackOrder: fc.array(fc.nat(), { minLength: 1, maxLength: 8 }),
})

type PageFetch = { d: Controllable<Page>; param: number; value: number }

type OpRec = {
  id: number
  kind: 'refetch' | 'next' | 'prev'
  signal: AbortSignal
  honorsAbort: boolean
  fetches: PageFetch[]
  superseded: boolean
  done: boolean
  promise: Tracked<unknown>
}

type Baseline = { pages: Page[]; params: number[] }
type Updater = (prev: Page[] | undefined) => Page[]
type Layer = {
  snap: Snapshot
  baseline: Baseline
  updater: Updater
  /** The params the write was given, which a replay applies as the write did. */
  given: number[] | undefined
  epoch: number
}

/** The engine's param alignment (`alignParams` in `infinite.ts`), `initialPageParam` 0. */
const align = (params: number[], length: number, given: number[] | undefined): number[] => {
  if (given !== undefined && given.length === length) return [...given]
  if (length === params.length) return params
  if (length < params.length) return params.slice(0, length)
  const pad = params.length > 0 ? (params[params.length - 1] as number) : 0
  return [...params, ...Array.from({ length: length - params.length }, () => pad)]
}

/** `updater` over one baseline, as the engine re-derives it. */
const derive = (b: Baseline, updater: Updater, given: number[] | undefined): Baseline => {
  const pages = updater(b.pages.length === 0 ? undefined : b.pages)
  return { pages, params: align(b.params, pages.length, given) }
}

type Options = {
  /**
   * Also assert, whenever the microtask queue has drained, that each paging
   * flag is true exactly while an op of its direction is current. Every
   * fetcher honors its abort signal in this mode, so a superseded request
   * settles within the drain.
   */
  strictDirectionFlags: boolean
  /** Expect a canonical write over live snapshots to rebase them (SPEC §6.4) instead of skipping the check. */
  canonicalRebases: boolean
}

async function runScenario(
  scenario: { ops: Op[]; finalOutcomes: Outcome[]; rollbackOrder: number[] },
  options: Options,
): Promise<void> {
  const ops: OpRec[] = []
  const opsBySignal = new Map<AbortSignal, OpRec>()
  const allFetches: PageFetch[] = []
  const violations: string[] = []
  let honorsNext = false
  let pendingKind: OpRec['kind'] = 'refetch'
  let seq = 0

  const entry = new InfiniteEntry<Page, Page, number>({
    fetcher: ({ pageParam, signal }) => {
      let op = opsBySignal.get(signal)
      if (op === undefined) {
        op = {
          id: ops.length,
          kind: pendingKind,
          signal,
          honorsAbort: honorsNext,
          fetches: [],
          superseded: false,
          done: false,
          promise: { state: 'pending' },
        }
        ops.push(op)
        opsBySignal.set(signal, op)
      } else if (op.superseded) {
        violations.push(`superseded op ${op.id} fetched page ${pageParam}`)
      }
      const f: PageFetch = {
        d: controllable<Page>(signal, op.honorsAbort),
        param: pageParam,
        value: 5_000_000 + allFetches.length,
      }
      op.fetches.push(f)
      allFetches.push(f)
      return f.d.promise
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.p < MAX_PARAM ? last.p + 1 : null),
    getPreviousPageParam: (first) => (first.p > MIN_PARAM ? first.p - 1 : null),
    retry: 0,
  })

  let current: OpRec | null = null
  const layers: Layer[] = []
  const snaps: Layer[] = []
  const callPromises: Tracked<unknown>[] = []
  /** False once a write whose rebase semantics are not settled landed over live snapshots. */
  let exact = true
  /** Server reads (refetch successes, hydrated rows) so far. */
  let epoch = 0

  const tainted = (): Set<number> => {
    const out = new Set<number>()
    for (const op of ops) if (op.superseded) for (const f of op.fetches) out.add(f.value)
    return out
  }

  const supersedeCurrent = (): void => {
    if (current !== null) current.superseded = true
    current = null
  }

  const observe = (): Baseline => ({ pages: entry.pages.peek(), params: entry.pageParams.peek() })

  const check = (where: string, quiescent: boolean): void => {
    const pages = entry.pages.peek()
    const params = entry.pageParams.peek()
    expect(params.length, `${where}: pages/pageParams out of line`).toBe(pages.length)
    expect(entry.isFetching.peek(), `${where}: isFetching`).toBe(current !== null)
    expect(entry.hasPendingMutations.peek(), `${where}: hasPendingMutations`).toBe(
      layers.length > 0,
    )
    const bad = tainted()
    for (const page of pages) {
      expect(bad.has(page.v), `${where}: page ${JSON.stringify(page)} from a superseded op`).toBe(
        false,
      )
    }
    expect(violations, where).toEqual([])
    if (options.strictDirectionFlags && quiescent) {
      expect(
        {
          isFetchingNextPage: entry.isFetchingNextPage.peek(),
          isFetchingPreviousPage: entry.isFetchingPreviousPage.peek(),
        },
        `${where}: direction flags`,
      ).toEqual({
        isFetchingNextPage: (current as OpRec | null)?.kind === 'next',
        isFetchingPreviousPage: (current as OpRec | null)?.kind === 'prev',
      })
    }
  }

  const settle = (f: PageFetch, outcome: Outcome): void => {
    if (outcome === 'resolve') f.d.resolve({ p: f.param, v: f.value })
    else if (outcome === 'reject') f.d.reject(new Error(`page ${f.param} failed`))
    else f.d.reject(new DOMException(`page ${f.param} aborted itself`, 'AbortError'))
  }

  const flush = async (): Promise<void> => {
    await flushMicrotasks()
    const op = current as OpRec | null
    if (op !== null && op.promise.state !== 'pending') {
      op.done = true
      current = null
      // A page fetch's rebase is not modelled, so the rollback check is off
      // until the stack empties.
      if (op.promise.state === 'fulfilled' && layers.length > 0) exact = false
      if (op.promise.state === 'fulfilled' && op.kind === 'refetch') epoch += 1
    }
  }

  const call = (kind: 'start' | 'next' | 'prev', via: () => Promise<unknown>, honors: boolean) => {
    const pagesBefore = entry.pages.peek().length
    honorsNext = honors || options.strictDirectionFlags
    pendingKind = kind === 'start' || pagesBefore === 0 ? 'refetch' : kind
    const before = ops.length
    const p = track(via())
    callPromises.push(p)
    if (ops.length === before) return // deduped or nothing to fetch: no request, no supersede
    expect(ops.length, 'one call starts at most one op').toBe(before + 1)
    const op = ops[before] as OpRec
    op.promise = p
    supersedeCurrent()
    current = op
  }

  /** Pages for `shape` over `prev`. New pages take `v0` and `v0 + 1`, so a re-run gives the same pages. */
  const makePages = (prev: Page[] | undefined, shape: Shape, v0: number): Page[] => {
    const ps = prev ?? []
    let k = 0
    const v = (): number => v0 + k++
    switch (shape) {
      case 'append':
        return [...ps, { p: (ps[ps.length - 1]?.p ?? -1) + 1, v: v() }]
      case 'prepend':
        return [{ p: (ps[0]?.p ?? 1) - 1, v: v() }, ...ps]
      case 'dropLast':
        return ps.slice(0, -1)
      case 'dropFirst':
        return ps.slice(1)
      case 'clear':
        return []
      case 'replace2':
        return [
          { p: 0, v: v() },
          { p: 1, v: v() },
        ]
    }
  }

  const modelRollback = (layer: Layer, where: string): void => {
    const i = layers.indexOf(layer)
    const before = observe()
    layer.snap.rollback()
    if (i === -1) {
      expect(observe(), `${where}: settled snapshot rolled back twice`).toEqual(before)
      return
    }
    if (i === layers.length - 1) {
      if (exact) expect(observe(), `${where}: top rollback`).toEqual(layer.baseline)
      layers.splice(i, 1)
    } else {
      // A rollback below the top replays the layers above it over the
      // baseline it restored (§6.4).
      ;(layers[i + 1] as Layer).baseline = layer.baseline
      layers.splice(i, 1)
      let b = (layers[i] as Layer).baseline
      for (let j = i; j < layers.length; j++) {
        const l = layers[j] as Layer
        if (j > i) l.baseline = b
        if (l.epoch === epoch) b = derive(b, l.updater, l.given)
      }
      if (exact) expect(observe(), `${where}: non-top rollback replays the layers above`).toEqual(b)
    }
    if (layers.length === 0) exact = true
  }

  for (const [n, op] of scenario.ops.entries()) {
    const where = `op #${n} ${JSON.stringify(op)}`
    switch (op.t) {
      case 'start':
        call(
          'start',
          () =>
            op.via === 'startFetch'
              ? entry.startFetch()
              : op.via === 'refetch'
                ? entry.refetch()
                : entry.invalidate(),
          op.honorsAbort,
        )
        break
      case 'next':
        call('next', () => entry.fetchNextPage(), op.honorsAbort)
        break
      case 'prev':
        call('prev', () => entry.fetchPreviousPage(), op.honorsAbort)
        break
      case 'settle': {
        const cur = current as OpRec | null
        const pool = op.current && cur !== null ? cur.fetches : allFetches
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
        supersedeCurrent()
        break
      case 'reset':
        entry.reset()
        break
      case 'set': {
        const baseline = observe()
        const v0 = 1_000_000 + seq
        seq += 2
        // Build the pages up front so matching params can go in alongside
        // them; `mismatch` hands in a wrong-length list, which the entry
        // must ignore in favour of trimming or padding.
        const written = makePages(
          baseline.pages.length === 0 ? undefined : baseline.pages,
          op.shape,
          v0,
        )
        const updater: Updater = op.patch ? (prev) => makePages(prev, op.shape, v0) : () => written
        const whole = !op.tracked && op.whole && !op.patch
        const opts: { track: boolean; whole?: boolean; pageParams?: number[] } = {
          track: op.tracked,
          whole,
        }
        if (op.params === 'match') opts.pageParams = written.map((pg) => pg.p)
        if (op.params === 'mismatch') {
          opts.pageParams = Array.from({ length: written.length + 1 }, () => 42)
        }
        const snap = entry.setData(updater, opts)
        if (op.tracked) {
          const layer: Layer = { snap, baseline, updater, given: opts.pageParams, epoch }
          layers.push(layer)
          snaps.push(layer)
        } else if (layers.length > 0) {
          if (options.canonicalRebases) {
            for (const l of layers) {
              l.baseline = whole ? observe() : derive(l.baseline, updater, opts.pageParams)
            }
          } else {
            exact = false
          }
        }
        break
      }
      case 'rollback': {
        const layer = pickFrom(snaps, op.pick)
        if (layer !== undefined) modelRollback(layer, where)
        break
      }
      case 'finalize': {
        const layer = pickFrom(snaps, op.pick)
        if (layer === undefined) break
        layer.snap.finalize()
        const i = layers.indexOf(layer)
        if (i !== -1) {
          // A commit folds into the baselines below it, unless a server read
          // landed since the layer was pushed.
          if (layer.epoch === epoch) {
            for (const l of layers.slice(0, i))
              l.baseline = derive(l.baseline, layer.updater, layer.given)
          }
          layers.splice(i, 1)
        }
        if (layers.length === 0) exact = true
        break
      }
      case 'hydrate': {
        const pages = Array.from({ length: op.count }, (_, i) => ({ p: i, v: 4_000_000 + seq++ }))
        entry.applyHydration(
          pages,
          pages.map((pg) => pg.p),
          Date.now(),
        )
        supersedeCurrent()
        // Hydration rebases live snapshots, like a canonical write.
        if (layers.length > 0) {
          if (options.canonicalRebases) for (const l of layers) l.baseline = observe()
          else exact = false
        }
        epoch += 1
        break
      }
    }
    check(where, op.t === 'flush')
  }

  // Settle everything still open until quiet. A refetch asks for its next page
  // only after the previous one lands, so this takes rounds.
  await flush()
  for (let round = 0; round < 20; round++) {
    const open = allFetches.filter((f) => !f.d.settled)
    if (open.length === 0) break
    open.forEach((f, i) => {
      settle(f, scenario.finalOutcomes[(round + i) % scenario.finalOutcomes.length] as Outcome)
    })
    await flush()
    check(`final drain round ${round}`, true)
  }
  expect(
    allFetches.every((f) => f.d.settled),
    'drain did not quiesce',
  ).toBe(true)

  // No flag stuck after everything settled, and no status wedged at 'pending'.
  expect({
    isFetching: entry.isFetching.peek(),
    isFetchingNextPage: entry.isFetchingNextPage.peek(),
    isFetchingPreviousPage: entry.isFetchingPreviousPage.peek(),
  }).toEqual({ isFetching: false, isFetchingNextPage: false, isFetchingPreviousPage: false })
  expect(entry.status.peek()).not.toBe('pending')
  for (const [i, p] of callPromises.entries()) {
    expect(p.state, `call #${i} promise`).not.toBe('pending')
  }
  for (const op of ops) {
    if (op.superseded) expect(op.promise.state, `superseded op ${op.id}`).toBe('rejected')
  }

  // Roll back every live snapshot in the generated order.
  const expected = layers.length > 0 ? (layers[0] as Layer).baseline : observe()
  const wasExact = exact
  let j = 0
  while (layers.length > 0) {
    const pick = scenario.rollbackOrder[j++ % scenario.rollbackOrder.length] as number
    modelRollback(layers[pick % layers.length] as Layer, `final rollback #${j}`)
    check(`final rollback #${j}`, true)
  }
  if (wasExact) expect(observe(), 'rollback of every layer').toEqual(expected)
  expect(entry.hasPendingMutations.peek()).toBe(false)
  entry.dispose()
}

describe('InfiniteEntry — property', () => {
  test(
    'page fetches race, cancel and hydrate without misaligning or leaking a superseded page',
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, (scenario) =>
          runScenario(scenario, { strictDirectionFlags: true, canonicalRebases: true }),
        ),
        { numRuns: NUM_RUNS },
      )
    },
    PROPERTY_TIMEOUT,
  )
})
