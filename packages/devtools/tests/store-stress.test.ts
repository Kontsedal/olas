import type { DebugCacheEntry, DebugEvent } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { DEFAULT_MAX_TIMELINE_ENTRIES, DevtoolsStore } from '../src/store'

// T8.2 acceptance: 1,000 controllers and 50,000 events through the store's
// apply loop, in frame-sized batches. The test times the loop, not the DOM,
// and asserts how the time SCALES rather than a wall-clock number, which would
// flake on a loaded CI runner. Set DEVTOOLS_STRESS_REPORT=1 to print the
// measured numbers.

/** The package has no Node types; the env is read through `globalThis`. */
const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

/** Events per frame: 250 at 60 fps is 15,000 events a second, a heavy app. */
const BATCH = 250

/**
 * The most a doubled workload may cost, as a multiple of the single one.
 * Linear work doubles, and quadratic work quadruples. 3 still fails a
 * quadratic regression, and leaves room for a loaded CI runner: 2.5 failed
 * once on GitHub Actions at 2.54 with linear code.
 */
const LINEAR_BOUND = 3

/** A deterministic PRNG, so every run replays the same workload. */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648
    return s / 2_147_483_648
  }
}

/** root → 10 features → 99 items: 1,001 controllers, built by the first events. */
function controllerPaths(): string[][] {
  const paths: string[][] = [['root']]
  for (let f = 0; f < 10; f++) {
    paths.push(['root', `feature[${f}]`])
    for (let i = 0; i < 99; i++) paths.push(['root', `feature[${f}]`, `item[${i}]`])
  }
  return paths
}

/** `total` events: the tree first, then a mix of every family the store routes. */
function workload(total: number): DebugEvent[] {
  const next = rng(7)
  const paths = controllerPaths()
  const events: DebugEvent[] = paths.map(
    (path) => ({ type: 'controller:constructed', path, props: { id: path.length } }) as DebugEvent,
  )
  const items = paths.filter((p) => p.length === 3)
  let seq = 0
  while (events.length < total) {
    const r = next()
    const item = items[Math.floor(next() * items.length)] as string[]
    const key = ['q', Math.floor(next() * 200)]
    const causeId = `c${Math.floor(seq++ / 3)}`
    if (r < 0.3) {
      events.push({
        type: 'cache:set-data',
        queryKey: key,
        source: 'fetch',
        data: { n: seq },
        causeId,
      })
    } else if (r < 0.4) {
      events.push({ type: 'cache:fetch-start', queryId: 'q', queryKey: key, causeId })
    } else if (r < 0.5) {
      events.push({ type: 'cache:fetch-success', queryKey: key, durationMs: 3, causeId })
    } else if (r < 0.6) {
      events.push({ type: 'mutation:run', path: item, name: 'save', vars: { seq }, causeId })
    } else if (r < 0.7) {
      events.push({ type: 'mutation:success', path: item, name: 'save', result: seq, causeId })
    } else if (r < 0.8) {
      events.push({
        type: 'field:validated',
        path: item,
        field: 'title',
        valid: r < 0.75,
        errors: [],
      })
    } else if (r < 0.85) {
      events.push({ type: r < 0.825 ? 'controller:suspended' : 'controller:resumed', path: item })
    } else if (r < 0.9) {
      // Churn: dispose and re-construct, so the disposed cap and pruning run.
      events.push({ type: 'controller:disposed', path: item })
      events.push({ type: 'controller:constructed', path: item, props: { again: seq } })
    } else if (r < 0.95) {
      events.push({
        type: 'plugin:event',
        plugin: r < 0.925 ? 'cross-tab' : 'entities',
        payload: { seq },
      })
    } else {
      events.push({ type: 'controller:debug', path: item, values: { seq } })
    }
  }
  return events.slice(0, total)
}

const entries: DebugCacheEntry[] = Array.from({ length: 50 }, (_, i) => ({
  queryId: 'q',
  key: ['q', i],
  status: 'success',
  data: i,
  error: undefined,
  lastUpdatedAt: 1,
  isStale: false,
  isFetching: false,
  hasPendingMutations: false,
}))

/**
 * Feed `events` in frame-sized batches. Each "frame" handles its batch, runs
 * the store's scheduled flush and reads every signal the panel renders from.
 * Returns the per-frame times in ms.
 */
function run(events: readonly DebugEvent[]): { frames: number[]; store: DevtoolsStore } {
  const queue: Array<() => void> = []
  const store = new DevtoolsStore({ coalesce: (fn) => queue.push(fn), now: () => 0 })
  store.attach({ debug: { subscribe: () => () => {}, queryEntries: () => entries } })
  const frames: number[] = []
  for (let i = 0; i < events.length; i += BATCH) {
    const t0 = performance.now()
    const end = Math.min(i + BATCH, events.length)
    for (let j = i; j < end; j++) store.handle(events[j] as DebugEvent)
    for (const flush of queue.splice(0)) flush()
    store.tree$.peek()
    store.events$.peek()
    store.cache$.peek()
    store.mutations$.peek()
    store.fields$.peek()
    frames.push(performance.now() - t0)
  }
  return { frames, store }
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] as number
}
/** The fastest of `n` runs: the least disturbed by GC and the scheduler. */
const best = (n: number, fn: () => number): number =>
  Math.min(...Array.from({ length: n }, () => fn()))

describe('DevtoolsStore under load — T8.2', () => {
  const events = workload(50_000)

  test('1,000 controllers and 50,000 events: the ring holds exactly its capacity', () => {
    const { store } = run(events)
    expect(store.events$.peek()).toHaveLength(DEFAULT_MAX_TIMELINE_ENTRIES)
    // Every event reaches the timeline except `controller:debug`, which is state, not history.
    const onTimeline = events.filter((e) => e.type !== 'controller:debug').length
    expect(store.droppedEvents$.peek()).toBe(onTimeline - DEFAULT_MAX_TIMELINE_ENTRIES)
    // The tree kept all 1,001 controllers: churned items were re-constructed.
    const count = (n: { children: readonly unknown[] }): number =>
      1 + (n.children as Array<{ children: readonly unknown[] }>).reduce((a, c) => a + count(c), 0)
    expect(count(store.tree$.peek()) - 1).toBe(1_001)
  })

  test('doubling the events at most ~doubles the time: no O(n²) in the apply loop', () => {
    run(events) // warm the JIT on the full workload first
    const half = events.slice(0, 25_000)
    const tHalf = best(5, () => sum(run(half).frames))
    const tFull = best(5, () => sum(run(events).frames))
    if (env.DEVTOOLS_STRESS_REPORT) {
      const { frames } = run(events)
      const sorted = [...frames].sort((a, b) => a - b)
      console.info(
        `[devtools stress] 25k: ${tHalf.toFixed(1)}ms, 50k: ${tFull.toFixed(1)}ms, ratio ${(tFull / tHalf).toFixed(2)}; ` +
          `per ${BATCH}-event frame: median ${median(frames).toFixed(2)}ms, ` +
          `p95 ${(sorted[Math.floor(sorted.length * 0.95)] as number).toFixed(2)}ms, ` +
          `max ${(sorted[sorted.length - 1] as number).toFixed(2)}ms`,
      )
    }
    expect(tFull / tHalf).toBeLessThan(LINEAR_BOUND)
  })

  test('a frame costs the same once the store is full as while it is filling', () => {
    // With the ring full, the tree built and the disposed cap reached, a
    // frame must not cost more than it did early on: per-event work does not
    // grow with what the store already holds.
    const { frames } = run(events)
    const early = median(frames.slice(8, 28)) // after the tree is built
    const late = median(frames.slice(-20))
    expect(late / early).toBeLessThan(LINEAR_BOUND)
  })

  test('sibling fan-out: 10,000 children of one parent cost ~2× 5,000, not 4×', () => {
    // The old tree found a child by a linear scan of its siblings, so N
    // children under one parent cost O(N²). The keyed tree finds it in O(1).
    const build = (n: number): number => {
      const store = new DevtoolsStore({ coalesce: () => 1 })
      const t0 = performance.now()
      store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
      for (let i = 0; i < n; i++) {
        const path = ['root', `row[${i}]`]
        store.handle({ type: 'controller:constructed', path, props: i })
        store.handle({ type: 'controller:suspended', path })
      }
      store.tree$.peek()
      return performance.now() - t0
    }
    build(10_000) // warm-up
    const t5 = best(5, () => build(5_000))
    const t10 = best(5, () => build(10_000))
    expect(t10 / t5).toBeLessThan(LINEAR_BOUND)
  })
})
