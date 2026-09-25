import { type DebugCacheEntry, type DebugEvent, signal } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { DEFAULT_MAX_TIMELINE_ENTRIES, DevtoolsStore } from '../src/store'
import { toSearchText } from '../src/util'

// T8.2 (ring buffer, keyed tree, frozen disposal) and T8.3 (search index),
// store side. The panel side is in panel-foundation.test.tsx.

const fixedNow = () => 1000
const constructed = (path: string[], extra: Partial<DebugEvent> = {}): DebugEvent =>
  ({ type: 'controller:constructed', path, props: undefined, ...extra }) as DebugEvent
const disposed = (path: string[]): DebugEvent => ({ type: 'controller:disposed', path })
const gc = (k: string): DebugEvent => ({ type: 'cache:gc', queryKey: [k] })
/** Test-only view of the store's private bookkeeping. */
const internals = (store: DevtoolsStore) =>
  store as unknown as {
    disposedQueue: unknown[]
    starts: { names: Map<string, unknown>; kids: Map<string, unknown> }
  }

describe('the timeline ring buffer', () => {
  test('defaults to 10,000 events', () => {
    expect(new DevtoolsStore().maxTimelineEntries).toBe(DEFAULT_MAX_TIMELINE_ENTRIES)
    expect(DEFAULT_MAX_TIMELINE_ENTRIES).toBe(10_000)
  })

  test('holds exactly its capacity, oldest first, and counts what it overwrote', () => {
    const store = new DevtoolsStore({ maxTimelineEntries: 4, now: fixedNow })
    for (let i = 0; i < 10; i++) store.handle(gc(`k${i}`))
    const keys = store.events$
      .peek()
      .map((e) => (e.event as { queryKey: readonly unknown[] }).queryKey[0])
    expect(keys).toEqual(['k6', 'k7', 'k8', 'k9'])
    expect(store.droppedEvents$.peek()).toBe(6)
  })

  test('clearLogs empties the ring and resets the dropped count', () => {
    const store = new DevtoolsStore({ maxTimelineEntries: 2, now: fixedNow })
    for (let i = 0; i < 5; i++) store.handle(gc(`k${i}`))
    store.clearLogs()
    expect(store.events$.peek()).toEqual([])
    expect(store.droppedEvents$.peek()).toBe(0)
    store.handle(gc('after'))
    expect(store.events$.peek()).toHaveLength(1)
  })

  test('events dropped while paused are not counted as overwritten', () => {
    const store = new DevtoolsStore({ maxTimelineEntries: 2, now: fixedNow })
    store.pause()
    for (let i = 0; i < 5; i++) store.handle(gc(`k${i}`))
    expect(store.droppedEvents$.peek()).toBe(0)
  })

  test('a capacity of 0 keeps nothing and counts every event', () => {
    const store = new DevtoolsStore({ maxTimelineEntries: 0, now: fixedNow })
    store.handle(gc('a'))
    store.handle(gc('b'))
    expect(store.events$.peek()).toEqual([])
    expect(store.droppedEvents$.peek()).toBe(2)
  })

  test('the array is built lazily and is stable until the ring changes', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(gc('a'))
    const first = store.events$.peek()
    expect(store.events$.peek()).toBe(first)
    store.handle({ type: 'controller:suspended', path: ['nobody'] })
    expect(store.events$.peek()).not.toBe(first)
  })
})

describe('the keyed controller tree', () => {
  test('an update rebuilds only the changed path: sibling subtrees keep their identity', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(constructed(['root']))
    store.handle(constructed(['root', 'a']))
    store.handle(constructed(['root', 'a', 'leaf']))
    store.handle(constructed(['root', 'b']))
    const before = store.tree$.peek()
    const [a, b] = before.children[0]?.children ?? []
    store.handle({ type: 'controller:suspended', path: ['root', 'b'] })
    const after = store.tree$.peek()
    expect(after).not.toBe(before)
    expect(after.children[0]?.children[0]).toBe(a) // untouched subtree reused
    expect(after.children[0]?.children[1]).not.toBe(b)
    expect(after.children[0]?.children[1]?.state).toBe('suspended')
  })

  test('controller:debug and lifecycle events for an unknown path are ignored', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(constructed(['root']))
    const before = store.tree$.peek()
    store.handle({ type: 'controller:debug', path: ['ghost'], values: { a: 1 } })
    store.handle({ type: 'controller:resumed', path: ['ghost'] })
    store.handle(disposed(['ghost']))
    expect(store.tree$.peek()).toBe(before)
  })

  test('a lifecycle event on the virtual root (path []) never prunes it', () => {
    const store = new DevtoolsStore({ maxDisposedNodes: 0, now: fixedNow })
    store.handle(constructed([]))
    store.handle(disposed([]))
    expect(store.tree$.peek().state).toBe('disposed')
    expect(store.tree$.peek().path).toEqual([])
  })

  test('disposing freezes the debug record: signals become the value they held', () => {
    const count = signal(3)
    const broken = {
      peek: () => {
        throw new Error('gone')
      },
      subscribeChanges: () => () => {},
    }
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(constructed(['root'], { debug: { count, broken, plain: 'x' } }))
    expect(store.tree$.peek().children[0]?.debug?.count).toBe(count) // live while alive
    store.handle({ ...disposed(['root']), t: 4242 })
    count.set(99)
    const node = store.tree$.peek().children[0]
    expect(node?.debug?.count).toBe(3) // the dispose-time value
    expect(node?.debug?.plain).toBe('x')
    expect(node?.debug?.broken).toBeInstanceOf(Error)
    expect(node?.disposedAt).toBe(4242)
  })

  test('disposedAt falls back to the store clock for an unstamped event', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(constructed(['root']))
    store.handle(disposed(['root']))
    expect(store.tree$.peek().children[0]?.disposedAt).toBe(1000)
  })

  test('a re-construction after a dispose clears the old instance’s frozen variables', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(constructed(['root'], { debug: { old: 1 } }))
    store.handle(disposed(['root']))
    store.handle(constructed(['root']))
    const node = store.tree$.peek().children[0]
    expect(node?.state).toBe('active')
    expect(node?.debug).toBeUndefined()
    expect(node?.disposedAt).toBeUndefined()
    store.handle(disposed(['root']))
    store.handle(constructed(['root'], { debug: { fresh: 2 } }))
    expect(store.tree$.peek().children[0]?.debug).toEqual({ fresh: 2 })
  })

  test('pruning drops the earliest-DISPOSED subtree first, not the earliest-constructed', () => {
    const store = new DevtoolsStore({ maxDisposedNodes: 1, now: fixedNow })
    store.handle(constructed(['root']))
    store.handle(constructed(['root', 'first']))
    store.handle(constructed(['root', 'second']))
    store.handle(disposed(['root', 'second']))
    store.handle(disposed(['root', 'first']))
    // `second` was disposed first, so it goes, although it was built later.
    expect(store.tree$.peek().children[0]?.children.map((c) => c.path[1])).toEqual(['first'])
  })

  test('churn on the same paths keeps the dispose queue bounded', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle(constructed(['root']))
    for (let round = 0; round < 200; round++) {
      for (let i = 0; i < 50; i++) {
        store.handle(constructed(['root', `row[${i}]`]))
        store.handle(disposed(['root', `row[${i}]`]))
      }
    }
    // 10,000 disposals of 50 paths: the queue holds the live candidates, not history.
    expect(internals(store).disposedQueue.length).toBeLessThanOrEqual(2 * 50 + 64)
    expect(store.tree$.peek().children[0]?.children).toHaveLength(50)
  })
})

describe('pending mutation starts', () => {
  test('a settled run leaves nothing behind in the trie', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.handle({ type: 'mutation:run', path: ['root', 'a', 'b'], id: 'save', vars: 1 })
    store.handle({ type: 'mutation:run', path: ['root', 'a'], vars: 1 })
    t = 5
    store.handle({ type: 'mutation:success', path: ['root', 'a', 'b'], id: 'save', result: 1 })
    expect(internals(store).starts.kids.size).toBe(1) // root › a still has a run
    store.handle({ type: 'mutation:error', path: ['root', 'a'], error: 'x' })
    expect(internals(store).starts.kids.size).toBe(0)
  })

  test('a settle for a path that never ran, or a name that never ran, has no duration', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'mutation:run', path: ['root'], id: 'a', vars: 1 })
    store.handle({ type: 'mutation:success', path: ['elsewhere'], id: 'a', result: 1 })
    store.handle({ type: 'mutation:success', path: ['root'], id: 'b', result: 1 })
    const settles = store.mutations$.peek().filter((m) => m.kind === 'success')
    expect(settles.map((m) => 'durationMs' in m && m.durationMs)).toEqual([false, false])
  })

  test('disposing the virtual root drops every pending start', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.handle({ type: 'mutation:run', path: ['root', 'x'], id: 'a', vars: 1 })
    store.handle(disposed([]))
    expect(internals(store).starts.kids.size).toBe(0)
  })
})

describe('store.search — T8.3', () => {
  const entry = (key: unknown[], data: unknown, status: DebugCacheEntry['status'] = 'success') =>
    ({
      queryId: 'q',
      key,
      status,
      data,
      error: undefined,
      lastUpdatedAt: 1,
      isStale: false,
      isFetching: false,
      hasPendingMutations: false,
    }) as DebugCacheEntry

  function seeded() {
    let handler: (e: DebugEvent) => void = () => {}
    let current = [
      { ...entry(['user', { id: 42, tab: 'posts' }], { name: 'Ada' }), queryId: 'users/byId' },
    ]
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handler = h
          return () => {}
        },
        queryEntries: () => current,
      },
    })
    const emit = (e: DebugEvent) => handler(e)
    emit(constructed(['root']))
    emit(constructed(['root', 'checkout'], { props: { cart: 'c-1' }, debug: { total: 1 } }))
    emit({
      type: 'cache:fetch-start',
      queryId: 'users/byId',
      queryKey: ['user', { id: 42, tab: 'posts' }],
    })
    emit({
      type: 'mutation:run',
      path: ['root', 'checkout'],
      id: 'placeOrder',
      vars: { sku: 'zeta-9' },
    })
    emit({
      type: 'field:validated',
      path: ['root', 'checkout'],
      field: 'email',
      valid: false,
      errors: ['Too short'],
    })
    emit({ type: 'plugin:event', plugin: 'cross-tab', payload: { peer: 'tab-7' } })
    return { store, emit, setEntries: (e: DebugCacheEntry[]) => (current = e) }
  }
  const kinds = (groups: ReturnType<DevtoolsStore['search']>) => groups.map((g) => g.kind)

  test('finds a controller by name and by path', () => {
    const { store } = seeded()
    const [controllers] = store.search('checkout')
    expect(controllers?.kind).toBe('controller')
    expect(controllers?.hits[0]).toMatchObject({
      label: 'checkout',
      detail: 'root › checkout',
      tab: 'tree',
    })
    expect(kinds(store.search('root › checkout'))).toContain('controller')
  })

  test('finds a query by the content of its key, labelled with its query id', () => {
    const { store } = seeded()
    const groups = store.search('posts')
    const queries = groups.find((g) => g.kind === 'query')
    expect(queries?.hits[0]).toMatchObject({
      label: 'users/byId · user › {"id":42,"tab":"posts"}',
      tab: 'inspector',
    })
    expect(store.search('users/byId').some((g) => g.kind === 'query')).toBe(true)
  })

  test('finds a payload value — in an event and in live query data', () => {
    const { store } = seeded()
    const payloads = store.search('zeta-9').find((g) => g.kind === 'event')
    expect(payloads?.hits[0]).toMatchObject({
      label: 'run · placeOrder · root › checkout',
      tab: 'timeline',
      lane: 'core',
    })
    expect(kinds(store.search('ada'))).toEqual(['query'])
  })

  test('finds mutations by name and fields by path, name or error', () => {
    const { store } = seeded()
    expect(store.search('placeorder').find((g) => g.kind === 'mutation')?.hits[0]?.label).toBe(
      'placeOrder',
    )
    expect(store.search('email').find((g) => g.kind === 'field')?.hits[0]?.detail).toBe(
      'root › checkout',
    )
    expect(kinds(store.search('too short'))).toEqual(['field'])
  })

  test('a plugin event is found by its plugin name and payload, on its lane', () => {
    const { store } = seeded()
    const hit = store.search('tab-7').find((g) => g.kind === 'event')?.hits[0]
    expect(hit).toMatchObject({ label: 'cross-tab', lane: 'plugin:cross-tab' })
    expect(store.search('cross-tab')).toHaveLength(1)
  })

  test('every term must match; an empty query finds nothing; limit caps hits but not total', () => {
    const { store, emit } = seeded()
    expect(store.search('checkout zzz')).toEqual([])
    expect(store.search('   ')).toEqual([])
    for (let i = 0; i < 12; i++) emit(constructed(['root', `row-${i}`]))
    const [rows] = store.search('row-', 5)
    expect(rows?.hits).toHaveLength(5)
    expect(rows?.total).toBe(12)
  })

  test('the latest run of a mutation is the one a hit points at', () => {
    const { store, emit } = seeded()
    const first = store.search('placeorder').find((g) => g.kind === 'mutation')?.hits[0]?.key
    emit({ type: 'mutation:success', path: ['root', 'checkout'], id: 'placeOrder', result: 1 })
    const latest = store.search('placeorder').find((g) => g.kind === 'mutation')?.hits[0]?.key
    expect(latest).not.toBe(first)
  })

  test('the index is built lazily, once per change, never per keystroke', () => {
    const { store, emit, setEntries } = seeded()
    expect(store.searchStats().builds).toBe(0) // nothing built until someone searches
    for (const q of ['c', 'ch', 'che', 'chec', 'check']) store.search(q)
    const afterTyping = store.searchStats()
    expect(afterTyping.builds).toBe(1)

    emit({ type: 'cache:set-data', queryKey: ['new'], source: 'write', data: { big: 'value' } })
    store.search('checko')
    store.search('checkou')
    const afterChange = store.searchStats()
    expect(afterChange.builds).toBe(2)
    // Only the new event was turned into text: controllers, the entry and the
    // earlier events were cached.
    expect(afterChange.indexed - afterTyping.indexed).toBe(1)

    // A changed entry is re-indexed; an unchanged one is not.
    setEntries([entry(['user', { id: 42, tab: 'posts' }], { name: 'Grace' })])
    emit({ type: 'cache:invalidated', queryKey: ['user'] })
    store.search('grace')
    expect(store.searchStats().indexed - afterChange.indexed).toBe(1)
  })
})

describe('toSearchText', () => {
  test('writes key:value tokens, unquoted', () => {
    expect(toSearchText({ name: 'Ada', tags: ['a', 'b'], nested: { n: 1 } })).toBe(
      'name:Ada tags: a b nested: n:1',
    )
  })

  test('renders the scalars and built-ins it meets', () => {
    const text = toSearchText([
      null,
      undefined,
      7n,
      Symbol('s'),
      () => {},
      new Error('down'),
      new Date(0),
      new Date(Number.NaN),
      new Map([['k', 'v']]),
      new Set(['x']),
    ])
    expect(text).toBe(
      'null undefined 7 Symbol(s) [fn] Error: down 1970-01-01T00:00:00.000Z Invalid Date k v x',
    )
  })

  test('marks a cycle instead of recursing, and keeps shared references', () => {
    const shared = { v: 1 }
    const cyclic: Record<string, unknown> = { a: shared, b: shared }
    cyclic.self = cyclic
    expect(toSearchText(cyclic)).toBe('a: v:1 b: v:1 self: [Circular]')
  })

  test('stops at the cap, inside a long string and across many keys', () => {
    expect(toSearchText('x'.repeat(50), 10)).toBe('x'.repeat(10))
    const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]))
    const text = toSearchText(many, 40)
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text.startsWith('k0:0 k1:1')).toBe(true)
    const list = toSearchText(
      Array.from({ length: 1000 }, (_, i) => i),
      20,
    )
    expect(list.length).toBeLessThanOrEqual(20)
    const map = toSearchText(new Map(Array.from({ length: 1000 }, (_, i) => [i, i])), 20)
    expect(map.length).toBeLessThanOrEqual(20)
  })

  test('skips inherited keys and survives a throwing getter', () => {
    const child = Object.create({ inherited: 1 }) as Record<string, unknown>
    child.own = 2
    expect(toSearchText(child)).toBe('own:2')
    const trap = {
      ok: 1,
      get bad(): never {
        throw new Error('no')
      },
    }
    expect(toSearchText(trap)).toBe('ok:1')
  })
})

describe('two queries with entries under the same key', () => {
  // Kanban's board and archive queries both hold an entry under ['b1']. The
  // key alone collided: one label for both, duplicate React keys, and a
  // shared diff baseline.
  const entry = (queryId: string, data: unknown): DebugCacheEntry => ({
    queryId,
    key: ['b1'],
    status: 'success',
    data,
    error: undefined,
    lastUpdatedAt: 1,
    isStale: false,
    isFetching: false,
    hasPendingMutations: false,
  })

  test('are two search hits, each labelled with its own query id', () => {
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      debug: {
        subscribe: () => () => {},
        queryEntries: () => [entry('board', { cards: 3 }), entry('archive', { pages: 1 })],
      },
    })
    const hits = store.search('b1').find((g) => g.kind === 'query')?.hits ?? []
    expect(hits.map((h) => h.label).sort()).toEqual(['archive · b1', 'board · b1'])
    expect(new Set(hits.map((h) => h.key)).size).toBe(2)
  })

  test('keep separate diff baselines', () => {
    let handler: (e: DebugEvent) => void = () => {}
    const store = new DevtoolsStore({ now: fixedNow })
    store.attach({
      debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handler = h
          return () => {}
        },
        queryEntries: () => [entry('board', { cards: 3 }), entry('archive', { pages: 1 })],
      },
    })
    handler({
      type: 'cache:set-data',
      queryId: 'board',
      queryKey: ['b1'],
      source: 'write',
      data: { cards: 4 },
    })
    const write = store.events$.peek().find((e) => e.event.type === 'cache:set-data')
    // The board's own previous value, not the archive's, which was seeded after it.
    expect(write?.prev).toEqual({ cards: 3 })
  })
})
