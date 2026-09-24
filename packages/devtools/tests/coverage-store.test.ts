import type { DebugEvent } from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  type ControllerNode,
  DevtoolsStore,
  insertNode,
  removeNodeAt,
  setNodeDebug,
  setNodeState,
} from '../src/store'

const fixedNow = () => 1000
const emptyRoot = (): ControllerNode => ({
  path: [],
  state: 'active',
  props: undefined,
  children: [],
})
const setData = (queryKey: readonly unknown[], data: unknown): DebugEvent => ({
  type: 'cache:set-data',
  queryKey,
  source: 'write',
  data,
})

describe('DevtoolsStore coalescing schedulers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("'raf' falls back to setTimeout when requestAnimationFrame is absent", () => {
    expect(typeof requestAnimationFrame).toBe('undefined') // node environment
    const store = new DevtoolsStore({ coalesce: 'raf', now: fixedNow })
    store.handle({ type: 'cache:fetch-start', queryKey: ['k'] })
    expect(store.cache$.peek()).toEqual([]) // buffered, not written yet
    vi.advanceTimersByTime(0)
    expect(store.cache$.peek().map((e) => e.kind)).toEqual(['fetch-start'])
    expect(store.events$.peek()).toHaveLength(1)
  })

  test("'raf' fallback: clearLogs cancels the pending timeout and the next event reschedules", () => {
    const store = new DevtoolsStore({ coalesce: 'raf', now: fixedNow })
    store.handle({ type: 'cache:fetch-start', queryKey: ['before'] })
    store.clearLogs()
    vi.advanceTimersByTime(10)
    expect(store.cache$.peek()).toEqual([]) // the cleared entry was not revived
    store.handle({ type: 'cache:fetch-start', queryKey: ['after'] })
    vi.advanceTimersByTime(0)
    expect(store.cache$.peek().map((e) => e.queryKey[0])).toEqual(['after'])
  })

  test("'raf': clearLogs cancels the pending frame through cancelAnimationFrame", () => {
    const frames = new Map<number, () => void>()
    const cancelled: number[] = []
    let nextHandle = 1
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      const h = nextHandle++
      frames.set(h, cb)
      return h
    })
    vi.stubGlobal('cancelAnimationFrame', (h: number) => {
      cancelled.push(h)
      frames.delete(h)
    })
    try {
      const store = new DevtoolsStore({ coalesce: 'raf', now: fixedNow })
      store.handle({ type: 'mutation:run', path: ['root'], vars: 1 })
      expect(frames.size).toBe(1)
      store.clearLogs()
      expect(cancelled).toEqual([1])
      expect(frames.size).toBe(0)
      expect(store.mutations$.peek()).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('a custom scheduler buffers until it runs; clearLogs hands its handle to cancelSchedule', () => {
    const queue: Array<() => void> = []
    const cancelled: number[] = []
    const store = new DevtoolsStore({
      now: fixedNow,
      coalesce: (fn) => queue.push(fn),
      cancelSchedule: (h) => cancelled.push(h),
    })
    store.handle({ type: 'field:validated', path: ['root'], field: 'a', valid: true, errors: [] })
    store.handle({ type: 'field:validated', path: ['root'], field: 'b', valid: true, errors: [] })
    expect(queue).toHaveLength(1) // one flush for the burst
    expect(store.fields$.peek()).toEqual([])
    queue[0]!()
    expect(store.fields$.peek().map((f) => f.field)).toEqual(['a', 'b'])

    store.handle({ type: 'field:validated', path: ['root'], field: 'c', valid: true, errors: [] })
    expect(queue).toHaveLength(2)
    store.clearLogs()
    expect(cancelled).toEqual([2]) // the handle the scheduler returned
  })

  test('a custom scheduler without cancelSchedule: clearLogs still drops the buffered entries', () => {
    const queue: Array<() => void> = []
    const store = new DevtoolsStore({ now: fixedNow, coalesce: (fn) => queue.push(fn) })
    store.handle({ type: 'cache:gc', queryKey: ['k'] })
    expect(() => store.clearLogs()).not.toThrow()
    queue[0]!() // the stale flush runs anyway
    expect(store.cache$.peek()).toEqual([])
    expect(store.events$.peek()).toEqual([])
  })

  test('a scheduler that returns handle 0 holds no pending flush, so each event schedules', () => {
    const queue: Array<() => void> = []
    const store = new DevtoolsStore({
      now: fixedNow,
      coalesce: (fn) => {
        queue.push(fn)
        return 0
      },
    })
    // `snapshot:*` feeds only the timeline, so one event = one push = one schedule call.
    store.handle({ type: 'snapshot:push', queryKey: ['a'] })
    store.handle({ type: 'snapshot:push', queryKey: ['b'] })
    expect(queue).toHaveLength(2)
    queue[0]!()
    expect(store.events$.peek().map((e) => e.event.type)).toEqual([
      'snapshot:push',
      'snapshot:push',
    ])
  })
})

describe('DevtoolsStore event routing gaps', () => {
  test('pause/resume toggles isPaused', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    expect(store.isPaused()).toBe(false)
    store.pause()
    expect(store.isPaused()).toBe(true)
    store.resume()
    expect(store.isPaused()).toBe(false)
  })

  test('cache:subscribed, fetch-error and invalidated land in cache$ with their fields', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    const error = new Error('down')
    store.handle({ type: 'cache:subscribed', queryKey: ['u'], subscriberPath: ['root', 'list'] })
    store.handle({ type: 'cache:fetch-error', queryKey: ['u'], error, durationMs: 12 })
    store.handle({ type: 'cache:invalidated', queryKey: ['u'] })
    expect(store.cache$.peek()).toEqual([
      {
        id: expect.any(Number),
        t: 1000,
        kind: 'subscribed',
        queryKey: ['u'],
        subscriberPath: ['root', 'list'],
      },
      {
        id: expect.any(Number),
        t: 1000,
        kind: 'fetch-error',
        queryKey: ['u'],
        durationMs: 12,
        error,
      },
      { id: expect.any(Number), t: 1000, kind: 'invalidated', queryKey: ['u'] },
    ])
  })

  test('mutation:error pairs with its run and carries the duration', () => {
    let t = 100
    const store = new DevtoolsStore({ now: () => t })
    store.handle({ type: 'mutation:run', path: ['root'], name: 'save', vars: 1 })
    t = 175
    store.handle({ type: 'mutation:error', path: ['root'], name: 'save', error: 'nope' })
    const err = store.mutations$.peek().find((e) => e.kind === 'error')
    expect(err).toMatchObject({ kind: 'error', name: 'save', error: 'nope', durationMs: 75 })
  })

  test('paused drops mutation and field entries', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.pause()
    store.handle({ type: 'mutation:rollback', path: ['root'], name: 'save' })
    store.handle({ type: 'field:validated', path: ['root'], field: 'f', valid: true, errors: [] })
    expect(store.mutations$.peek()).toEqual([])
    expect(store.fields$.peek()).toEqual([])
  })

  test('mutation and field logs are bounded by maxEntries — oldest drops first', () => {
    const store = new DevtoolsStore({ maxEntries: 2, now: fixedNow })
    for (let i = 0; i < 4; i++) {
      store.handle({ type: 'mutation:rollback', path: ['root'], name: `m${i}` })
      store.handle({
        type: 'field:validated',
        path: ['root'],
        field: `f${i}`,
        valid: true,
        errors: [],
      })
    }
    expect(store.mutations$.peek().map((m) => m.name)).toEqual(['m2', 'm3'])
    expect(store.fields$.peek().map((f) => f.field)).toEqual(['f2', 'f3'])
  })

  test('disposing a controller drops pending run starts for it and its descendants only', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.handle({ type: 'mutation:run', path: ['root', 'a'], name: 'save', vars: 1 })
    store.handle({ type: 'mutation:run', path: ['root', 'a', 'kid'], name: 'x', vars: 1 })
    store.handle({ type: 'mutation:run', path: ['root', 'ab'], name: 'y', vars: 1 })
    t = 40
    store.handle({ type: 'controller:disposed', path: ['root', 'a'] })
    store.handle({ type: 'mutation:success', path: ['root', 'a'], name: 'save', result: 1 })
    store.handle({ type: 'mutation:success', path: ['root', 'a', 'kid'], name: 'x', result: 1 })
    store.handle({ type: 'mutation:success', path: ['root', 'ab'], name: 'y', result: 1 })
    const durations = store.mutations$
      .peek()
      .filter((e) => e.kind === 'success')
      .map((e) => [e.name, 'durationMs' in e ? e.durationMs : undefined])
    // `root>ab` shares a string prefix with `root>a` but is a sibling — it keeps its start.
    expect(durations).toEqual([
      ['save', undefined],
      ['x', undefined],
      ['y', 40],
    ])
  })

  test('bigint query keys get a stable diff baseline', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(setData(['n', 1n], 'a'))
    store.handle(setData(['n', 1n], 'b'))
    store.handle(setData(['n', '1'], 'c')) // the string '1' is a different key
    const writes = store.events$.peek()
    expect(writes[1]!.prev).toBe('a')
    expect('prev' in writes[2]!).toBe(false)
  })

  test('a circular query key falls back to a type-tagged hash and still diffs', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    const key: unknown[] = ['self']
    key.push(key)
    expect(() => store.handle(setData(key, 1))).not.toThrow()
    store.handle(setData(key, 2))
    expect(store.events$.peek()[1]!.prev).toBe(1)
  })

  test('pruning a disposed subtree removes its descendants with it', () => {
    const store = new DevtoolsStore({ maxDisposedNodes: 1, now: fixedNow })
    const list = ['root', 'list']
    store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
    store.handle({ type: 'controller:constructed', path: list, props: undefined })
    store.handle({ type: 'controller:constructed', path: [...list, 'i0'], props: undefined })
    store.handle({ type: 'controller:constructed', path: [...list, 'i1'], props: undefined })
    store.handle({ type: 'controller:disposed', path: [...list, 'i0'] })
    expect(store.tree$.peek().children[0]?.children[0]?.children).toHaveLength(2)
    store.handle({ type: 'controller:disposed', path: [...list, 'i1'] })
    // Two disposed leaves exceed the cap: the first is pruned.
    expect(store.tree$.peek().children[0]?.children[0]?.children.map((c) => c.path[2])).toEqual([
      'i1',
    ])
    store.handle({ type: 'controller:disposed', path: list })
    // The whole `list` subtree (list + i1) is fully disposed and pruned as a unit.
    expect(store.tree$.peek().children[0]?.children).toEqual([])
    expect(store.tree$.peek().children[0]?.state).toBe('active')
  })
})

describe('pruning never removes a disposed node that has a live descendant', () => {
  test('over the cap, but nothing is fully disposed: the tree is kept as-is', () => {
    const store = new DevtoolsStore({ maxDisposedNodes: 0, now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
    store.handle({ type: 'controller:constructed', path: ['root', 'kid'], props: undefined })
    const before = store.tree$.peek()
    // The parent's dispose arrives while its child is still live.
    store.handle({ type: 'controller:disposed', path: ['root'] })
    const after = store.tree$.peek()
    expect(after).not.toBe(before)
    expect(after.children[0]?.state).toBe('disposed')
    expect(after.children[0]?.children.map((c) => c.state)).toEqual(['active'])
  })
})

describe('tree helpers — empty paths and missing nodes', () => {
  test('insertNode with an empty path updates the virtual root', () => {
    const root = emptyRoot()
    expect(insertNode(root, [], { p: 1 })).toEqual({ ...root, props: { p: 1 } })
    expect(insertNode(root, [], 2, { v: 1 })).toEqual({ ...root, props: 2, debug: { v: 1 } })
  })

  test('setNodeState / setNodeDebug with an empty path target the virtual root', () => {
    const root = emptyRoot()
    expect(setNodeState(root, [], 'suspended').state).toBe('suspended')
    expect(setNodeDebug(root, [], { a: 1 }).debug).toEqual({ a: 1 })
  })

  test('setNodeState on a missing grandchild leaves the tree unchanged', () => {
    const tree = insertNode(emptyRoot(), ['root'], undefined)
    expect(setNodeState(tree, ['root', 'ghost'], 'disposed')).toBe(tree)
  })

  test('removeNodeAt removes a nested node and ignores unresolved paths', () => {
    const tree = insertNode(insertNode(emptyRoot(), ['root', 'a'], 1), ['root', 'b'], 2)
    expect(removeNodeAt(tree, [])).toBe(tree) // the virtual root is never removed
    expect(removeNodeAt(tree, ['nope'])).toBe(tree)
    expect(removeNodeAt(tree, ['root', 'nope', 'deeper'])).toBe(tree)
    const next = removeNodeAt(tree, ['root', 'a'])
    expect(next.children[0]?.children.map((c) => c.path[1])).toEqual(['b'])
    expect(tree.children[0]?.children).toHaveLength(2) // immutable update
  })
})
