import type { DebugEvent } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { DevtoolsStore, insertNode, setNodeState } from '../src/store'

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
      store.handle({ type: 'controller:constructed', path: ['root', `item[${i}]`], props: undefined })
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
