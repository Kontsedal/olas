import type { DebugCacheEntry, DebugEvent } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { DevtoolsStore, insertNode, setNodeDebug, setNodeState } from '../src/store'

const fixedNow = () => 1000

describe('insertNode', () => {
  test('adds a top-level node under the virtual root', () => {
    const root = { path: [], state: 'active' as const, props: undefined, children: [] }
    const next = insertNode(root, ['root'], { foo: 1 })
    expect(next.children).toHaveLength(1)
    expect(next.children[0]?.path).toEqual(['root'])
    expect(next.children[0]?.props).toEqual({ foo: 1 })
  })

  test('inserts a nested node and auto-creates intermediate ancestors', () => {
    const root = { path: [], state: 'active' as const, props: undefined, children: [] }
    const t1 = insertNode(root, ['root', 'feature[0]', 'leaf[0]'], { id: 'x' })
    expect(t1.children[0]?.path).toEqual(['root'])
    expect(t1.children[0]?.children[0]?.path).toEqual(['root', 'feature[0]'])
    expect(t1.children[0]?.children[0]?.children[0]?.path).toEqual([
      'root',
      'feature[0]',
      'leaf[0]',
    ])
    expect(t1.children[0]?.children[0]?.children[0]?.props).toEqual({ id: 'x' })
  })

  test('updating an existing node preserves its children', () => {
    const root = { path: [], state: 'active' as const, props: undefined, children: [] }
    const t1 = insertNode(root, ['root', 'feature[0]'], undefined)
    const t2 = insertNode(t1, ['root', 'feature[0]', 'leaf[0]'], 1)
    const t3 = insertNode(t2, ['root', 'feature[0]'], { updated: true })
    expect(t3.children[0]?.children[0]?.props).toEqual({ updated: true })
    expect(t3.children[0]?.children[0]?.children).toHaveLength(1)
    expect(t3.children[0]?.children[0]?.children[0]?.path).toEqual([
      'root',
      'feature[0]',
      'leaf[0]',
    ])
  })
})

describe('setNodeState', () => {
  test('flips state at an existing path', () => {
    const root = { path: [], state: 'active' as const, props: undefined, children: [] }
    const t1 = insertNode(root, ['root', 'feature[0]'], undefined)
    const t2 = setNodeState(t1, ['root', 'feature[0]'], 'suspended')
    expect(t2.children[0]?.children[0]?.state).toBe('suspended')
  })

  test('out-of-order events for missing paths leave the tree unchanged', () => {
    const root = { path: [], state: 'active' as const, props: undefined, children: [] }
    const t = setNodeState(root, ['root', 'never-constructed'], 'disposed')
    expect(t).toBe(root)
  })
})

describe('DevtoolsStore.handle', () => {
  test('controller:constructed populates the tree', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: { id: 'x' } })
    const tree = store.tree$.peek()
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]?.state).toBe('active')
  })

  test('suspend/resume/dispose flow', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    const path = ['root']
    store.handle({ type: 'controller:constructed', path, props: undefined })
    store.handle({ type: 'controller:suspended', path })
    expect(store.tree$.peek().children[0]?.state).toBe('suspended')
    store.handle({ type: 'controller:resumed', path })
    expect(store.tree$.peek().children[0]?.state).toBe('active')
    store.handle({ type: 'controller:disposed', path })
    expect(store.tree$.peek().children[0]?.state).toBe('disposed')
  })

  test('cache:fetch-success appends to the timeline', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'cache:fetch-success', queryKey: ['user', '1'], durationMs: 42 })
    const entries = store.cache$.peek()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'fetch-success',
      queryKey: ['user', '1'],
      durationMs: 42,
      t: 1000,
    })
  })

  test('mutation:run/success/error/rollback all logged', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'mutation:run', path: ['root', 'save'], vars: { v: 1 } })
    store.handle({ type: 'mutation:error', path: ['root', 'save'], error: new Error('boom') })
    store.handle({ type: 'mutation:rollback', path: ['root', 'save'] })
    store.handle({ type: 'mutation:success', path: ['root', 'save'], result: 'ok' })
    const entries = store.mutations$.peek()
    expect(entries.map((e) => e.kind)).toEqual(['run', 'error', 'rollback', 'success'])
  })

  test('field:validated logged with valid/invalid + errors', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({
      type: 'field:validated',
      path: ['root', 'form'],
      field: 'email',
      valid: false,
      errors: ['Invalid email'],
    })
    const entries = store.fields$.peek()
    expect(entries[0]).toMatchObject({ field: 'email', valid: false, errors: ['Invalid email'] })
  })

  test('logs are bounded by maxEntries — oldest drops first', () => {
    const store = new DevtoolsStore({ maxEntries: 3, now: fixedNow })
    for (let i = 0; i < 5; i++) {
      store.handle({ type: 'cache:fetch-start', queryKey: [`k${i}`] })
    }
    const entries = store.cache$.peek()
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => (e as { queryKey: readonly unknown[] }).queryKey[0])).toEqual([
      'k2',
      'k3',
      'k4',
    ])
  })

  test('clearLogs empties cache/mutations/fields but preserves the tree', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
    store.handle({ type: 'cache:fetch-start', queryKey: ['k'] })
    store.handle({ type: 'mutation:run', path: ['root'], vars: 0 })
    store.handle({
      type: 'field:validated',
      path: ['root'],
      field: 'x',
      valid: true,
      errors: [],
    })
    store.clearLogs()
    expect(store.cache$.peek()).toEqual([])
    expect(store.mutations$.peek()).toEqual([])
    expect(store.fields$.peek()).toEqual([])
    expect(store.tree$.peek().children).toHaveLength(1)
  })

  test('concurrent runs of the same mutation each get a duration (FIFO pairing) — T6.3', () => {
    // Two overlapping runs of the SAME path+name. The old code keyed
    // mutationStarts by path#name with a single value, so the second `run`
    // OVERWROTE the first's start time and one duration was lost. A FIFO queue
    // of start times pairs each settle with the oldest pending start.
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    const path = ['root', 'save']
    t = 100
    store.handle({ type: 'mutation:run', path, vars: 1 })
    t = 110
    store.handle({ type: 'mutation:run', path, vars: 2 })
    t = 150
    store.handle({ type: 'mutation:success', path, result: 'a' })
    t = 200
    store.handle({ type: 'mutation:success', path, result: 'b' })
    const durations = store.mutations$
      .peek()
      .filter((e) => e.kind === 'success')
      .map((e) => (e as { durationMs?: number }).durationMs)
    expect(durations).toEqual([50, 90]) // 150-100, 200-110 — neither lost
  })

  test('prunes disposed subtrees beyond maxDisposedNodes; active nodes survive — T6.3', () => {
    const store = new DevtoolsStore({ maxDisposedNodes: 2, now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
    for (let i = 0; i < 5; i++) {
      store.handle({
        type: 'controller:constructed',
        path: ['root', `item[${i}]`],
        props: undefined,
      })
      store.handle({ type: 'controller:disposed', path: ['root', `item[${i}]`] })
    }
    const rootNode = store.tree$.peek().children[0]
    expect(rootNode?.state).toBe('active') // active root never pruned
    const disposed = rootNode?.children.filter((c) => c.state === 'disposed') ?? []
    expect(disposed.length).toBeLessThanOrEqual(2) // oldest disposed subtrees dropped
    // The two most-recent survive.
    expect(disposed.map((c) => c.path[1])).toEqual(['item[3]', 'item[4]'])
  })

  test('attach() subscribes to a root.__debug bus', () => {
    let captured: ((ev: DebugEvent) => void) | undefined
    const fakeRoot = {
      __debug: {
        subscribe: (handler: (ev: DebugEvent) => void) => {
          captured = handler
          return () => {
            captured = undefined
          }
        },
        queryEntries: () => [],
      },
    }
    const store = new DevtoolsStore({ now: fixedNow })
    const unsubscribe = store.attach(fakeRoot)
    captured?.({ type: 'controller:constructed', path: ['root'], props: 1 })
    expect(store.tree$.peek().children).toHaveLength(1)
    unsubscribe()
    expect(captured).toBeUndefined()
  })
})

describe('DevtoolsStore controller variables (ctx.debug)', () => {
  test('controller:constructed with debug populates node.debug', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({
      type: 'controller:constructed',
      path: ['root'],
      props: undefined,
      debug: { count: 3, name: 'x' },
    })
    expect(store.tree$.peek().children[0]?.debug).toEqual({ count: 3, name: 'x' })
  })

  test('controller:debug updates node.debug post-construction', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
    store.handle({ type: 'controller:debug', path: ['root'], values: { a: 1 } })
    expect(store.tree$.peek().children[0]?.debug).toEqual({ a: 1 })
  })

  test('a re-construction without debug preserves existing variables', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: 1, debug: { a: 1 } })
    store.handle({ type: 'controller:constructed', path: ['root'], props: 2 }) // no debug
    expect(store.tree$.peek().children[0]?.debug).toEqual({ a: 1 })
  })

  test('controller:debug does NOT land on the timeline', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
    store.handle({ type: 'controller:debug', path: ['root'], values: { a: 1 } })
    expect(store.events$.peek().some((e) => e.event.type === 'controller:debug')).toBe(false)
  })

  test('setNodeDebug sets debug at a path; a missing path leaves the tree unchanged', () => {
    const root = { path: [], state: 'active' as const, props: undefined, children: [] }
    const t1 = insertNode(root, ['root', 'f[0]'], undefined)
    const t2 = setNodeDebug(t1, ['root', 'f[0]'], { n: 1 })
    expect(t2.children[0]?.children[0]?.debug).toEqual({ n: 1 })
    expect(setNodeDebug(t1, ['root', 'nope'], { n: 1 })).toBe(t1)
  })
})

describe('DevtoolsStore unified timeline', () => {
  test('every event lands on the timeline in order', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'controller:constructed', path: ['root'], props: undefined })
    store.handle({ type: 'cache:fetch-start', queryKey: ['u', '1'] })
    store.handle({ type: 'mutation:run', path: ['root', 'save'], vars: 1 })
    const events = store.events$.peek()
    expect(events.map((e) => e.event.type)).toEqual([
      'controller:constructed',
      'cache:fetch-start',
      'mutation:run',
    ])
    // Un-stamped events (bare handle calls) get a monotonic fallback seq.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  test('prefers the emitter-supplied seq/t over the fallback', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'cache:gc', queryKey: ['a'], seq: 41, t: 5 })
    store.handle({ type: 'cache:gc', queryKey: ['b'], seq: 42, t: 6 })
    expect(store.events$.peek().map((e) => e.seq)).toEqual([41, 42])
    expect(store.events$.peek().map((e) => e.t)).toEqual([5, 6])
  })

  test('cache:set-data captures the prior value as `prev` for the diff', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'cache:set-data', queryKey: ['u', '1'], source: 'fetch', data: { n: 1 } })
    store.handle({ type: 'cache:set-data', queryKey: ['u', '1'], source: 'mutate', data: { n: 2 } })
    const writes = store.events$.peek().filter((e) => e.event.type === 'cache:set-data')
    expect(writes[0]!.prev).toBeUndefined() // first write to the key
    expect(writes[1]!.prev).toEqual({ n: 1 }) // diff baseline = prior data
  })

  test('carries causeId onto the timeline entry', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'mutation:run', path: ['root', 'save'], vars: 1, causeId: 'run-7' })
    store.handle({ type: 'snapshot:push', queryKey: ['u', '1'], causeId: 'run-7' })
    expect(store.events$.peek().map((e) => e.causeId)).toEqual(['run-7', 'run-7'])
  })

  test('distinct keys (undefined vs null) keep separate diff baselines', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'cache:set-data', queryKey: ['x', undefined], source: 'set', data: 1 })
    store.handle({ type: 'cache:set-data', queryKey: ['x', null], source: 'set', data: 2 })
    store.handle({ type: 'cache:set-data', queryKey: ['x', null], source: 'set', data: 3 })
    const writes = store.events$.peek().filter((e) => e.event.type === 'cache:set-data')
    // `['x', undefined]` and `['x', null]` must NOT alias onto one baseline.
    expect('prev' in writes[0]!).toBe(false) // ['x', undefined] first write
    expect('prev' in writes[1]!).toBe(false) // ['x', null] first write (not aliased)
    expect(writes[2]!.prev).toBe(2) // ['x', null] second write diffs against 2
  })

  test('timeline is bounded by maxTimelineEntries — oldest drops first', () => {
    const store = new DevtoolsStore({ maxTimelineEntries: 2, now: fixedNow })
    for (let i = 0; i < 4; i++) store.handle({ type: 'cache:fetch-start', queryKey: [`k${i}`] })
    const keys = store.events$
      .peek()
      .map((e) => (e.event as { queryKey: readonly unknown[] }).queryKey[0])
    expect(keys).toEqual(['k2', 'k3'])
  })

  test('paused drops timeline events too', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.pause()
    store.handle({ type: 'cache:fetch-start', queryKey: ['k'] })
    expect(store.events$.peek()).toEqual([])
  })

  test("coalesce:'raf' invokes requestAnimationFrame with the global `this` (real-browser regression)", () => {
    // A real browser throws "Illegal invocation" if native rAF is called as a
    // method of some other object (`this !== window`). jsdom's rAF ignores
    // `this`, so this must be asserted explicitly: assigning `requestAnimationFrame`
    // unbound to `this.schedule` used to throw here in the actual panel.
    const cbs: Array<() => void> = []
    function strictRaf(this: unknown, cb: () => void): number {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation')
      cbs.push(cb)
      return cbs.length
    }
    const origRaf = globalThis.requestAnimationFrame
    const origCaf = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = strictRaf as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
    try {
      const store = new DevtoolsStore({ coalesce: 'raf', now: fixedNow })
      // With the bug this throws 'Illegal invocation' (rAF called with this=store).
      store.handle({ type: 'cache:fetch-start', queryKey: ['k'] })
      expect(cbs).toHaveLength(1) // a flush was actually scheduled
      cbs[0]!() // run the rAF callback → flushPending
      expect(store.events$.peek().map((e) => e.event.type)).toEqual(['cache:fetch-start'])
    } finally {
      globalThis.requestAnimationFrame = origRaf
      globalThis.cancelAnimationFrame = origCaf
    }
  })

  test('clearLogs clears the timeline and resets the diff baseline', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'cache:set-data', queryKey: ['u', '1'], source: 'fetch', data: { n: 1 } })
    store.clearLogs()
    expect(store.events$.peek()).toEqual([])
    store.handle({ type: 'cache:set-data', queryKey: ['u', '1'], source: 'mutate', data: { n: 2 } })
    const write = store.events$.peek().find((e) => e.event.type === 'cache:set-data')
    expect(write!.prev).toBeUndefined() // baseline was reset by clearLogs
  })
})

describe('DevtoolsStore cacheState (event-driven inspector, no poll)', () => {
  const entry = (over: Partial<DebugCacheEntry> = {}): DebugCacheEntry => ({
    key: ['u', '1'],
    status: 'success',
    data: 1,
    error: undefined,
    lastUpdatedAt: 5,
    isStale: false,
    isFetching: false,
    hasPendingMutations: false,
    ...over,
  })

  test('seeds cacheState$ from queryEntries() on attach', () => {
    const snapshot = [entry()]
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      __debug: {
        subscribe: () => () => {},
        queryEntries: () => snapshot.slice(),
      },
    })
    expect(store.cacheState$.peek()).toEqual(snapshot)
  })

  test('seeds the diff baseline from queryEntries() on attach', () => {
    let handler: ((e: DebugEvent) => void) | undefined
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      __debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handler = h
          return () => {}
        },
        queryEntries: () => [entry({ key: ['1'], data: { n: 1 } })],
      },
    })
    // A write to the already-cached key diffs against the seeded value, not
    // "initial" — the fetch that populated it happened before we subscribed.
    handler?.({ type: 'cache:set-data', queryKey: ['1'], source: 'mutate', data: { n: 2 } })
    const write = store.events$.peek().find((e) => e.event.type === 'cache:set-data')
    expect(write!.prev).toEqual({ n: 1 })
  })

  test('refreshes cacheState$ on a cache event — no interval', () => {
    let current: DebugCacheEntry[] = []
    let handler: ((e: DebugEvent) => void) | undefined
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      __debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handler = h
          return () => {}
        },
        queryEntries: () => current.slice(),
      },
    })
    expect(store.cacheState$.peek()).toEqual([])
    current = [entry({ data: 42, lastUpdatedAt: 9 })]
    handler?.({ type: 'cache:set-data', queryKey: ['u', '1'], source: 'set', data: 42 })
    expect(store.cacheState$.peek()).toEqual(current)
  })

  test('a non-cache event does not re-read the snapshot', () => {
    let reads = 0
    let handler: ((e: DebugEvent) => void) | undefined
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      __debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handler = h
          return () => {}
        },
        queryEntries: () => {
          reads++
          return []
        },
      },
    })
    expect(reads).toBe(1) // seed only
    handler?.({ type: 'controller:suspended', path: ['root'] })
    expect(reads).toBe(1) // controller lifecycle doesn't touch the cache snapshot
  })

  test('cache:gc evicts the diff baseline so a re-fetch reads as an initial write', () => {
    let handler: ((e: DebugEvent) => void) | undefined
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      __debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handler = h
          return () => {}
        },
        queryEntries: () => [],
      },
    })
    handler?.({ type: 'cache:set-data', queryKey: ['1'], source: 'fetch', data: { n: 1 } })
    handler?.({ type: 'cache:gc', queryKey: ['1'] })
    handler?.({ type: 'cache:set-data', queryKey: ['1'], source: 'fetch', data: { n: 2 } })
    const writes = store.events$.peek().filter((e) => e.event.type === 'cache:set-data')
    // The post-gc write has no baseline (gc evicted it) → renders as initial,
    // not a diff against the pre-gc ghost value.
    expect('prev' in writes[1]!).toBe(false)
  })

  test('resume() re-syncs cacheState$ after a paused cache change', () => {
    let current: DebugCacheEntry[] = []
    let handler: ((e: DebugEvent) => void) | undefined
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      __debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handler = h
          return () => {}
        },
        queryEntries: () => current.slice(),
      },
    })
    store.pause()
    current = [entry({ data: 99 })]
    handler?.({ type: 'cache:set-data', queryKey: ['u', '1'], source: 'set', data: 99 })
    expect(store.cacheState$.peek()).toEqual([]) // dropped while paused, not refreshed
    store.resume()
    expect(store.cacheState$.peek()).toEqual(current) // forced back in sync on resume
  })
})
