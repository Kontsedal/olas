import {
  createMutation,
  createRoot,
  type DebugEvent,
  defineController,
  queryEngine,
} from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { DevtoolsStore, type MutationEntry } from '../src/store'

// Every mutation event core sends carries its run's id as `causeId`. The store
// pairs a settle with its start by that id, and closes a cancelled run on
// `mutation:cancel`. Pairing oldest-start-first gave a superseded run's start
// to the run that settled, and left the superseded starts queued forever.

const PATH = ['root', 'search']
const run = (causeId: string, vars: unknown = 'q'): DebugEvent => ({
  type: 'mutation:run',
  path: PATH,
  id: 'search',
  vars,
  causeId,
})
const success = (causeId: string): DebugEvent => ({
  type: 'mutation:success',
  path: PATH,
  id: 'search',
  result: [],
  causeId,
})
// The cast keeps the file typed against a core build that predates `mutation:cancel`.
const cancel = (causeId: string, reason = 'superseded', path = PATH): DebugEvent =>
  ({ type: 'mutation:cancel', path, id: 'search', reason, causeId }) as unknown as DebugEvent

/** The store's cause-keyed pending starts. */
const pendingRuns = (store: DevtoolsStore) =>
  (store as unknown as { runStarts: Map<string, number> }).runStarts
const summary = (entries: MutationEntry[]) =>
  entries.map((e) => {
    const out: unknown[] = [e.kind]
    if (e.kind === 'cancel') out.push(e.reason)
    if ('durationMs' in e) out.push(e.durationMs)
    return out
  })

describe('mutation runs pair by causeId', () => {
  test('three latest-wins runs: the settle pairs with its own start, not the oldest', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.handle(run('r1'))
    t = 100
    store.handle(run('r2'))
    t = 200
    store.handle(run('r3'))
    t = 210
    store.handle(success('r3'))
    const settled = store.mutations$.peek().find((e) => e.kind === 'success')
    expect(settled).toMatchObject({ durationMs: 10 })
  })

  test('mutation:cancel closes the run with its reason and its duration', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.handle(run('r1'))
    t = 100
    store.handle(cancel('r1'))
    store.handle(run('r2'))
    t = 200
    store.handle(cancel('r2'))
    store.handle(run('r3'))
    t = 210
    store.handle(success('r3'))
    expect(summary(store.mutations$.peek())).toEqual([
      ['run'],
      ['cancel', 'superseded', 100],
      ['run'],
      ['cancel', 'superseded', 100],
      ['run'],
      ['success', 10],
    ])
    expect(pendingRuns(store).size).toBe(0)
    const cancels = store.events$
      .peek()
      .filter((e) => e.event.type === ('mutation:cancel' as never))
    expect(cancels.map((e) => e.causeId)).toEqual(['r1', 'r2'])
  })

  test('a cancel whose run the store never saw stays off the log and the timeline', () => {
    const store = new DevtoolsStore({ now: () => 0 })
    // A queued serial run that reset dropped before it ever started.
    store.handle(cancel('queued', 'reset'))
    expect(store.mutations$.peek()).toEqual([])
    expect(store.events$.peek()).toEqual([])
  })

  test('a run cancelled by dispose closes after its controller:disposed', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.handle(run('r1'))
    t = 30
    // Core aborts the run inside dispose and reports the cancel a tick later.
    store.handle({ type: 'controller:disposed', path: PATH })
    store.handle(cancel('r1', 'dispose'))
    expect(summary(store.mutations$.peek())).toEqual([['run'], ['cancel', 'dispose', 30]])
  })

  test('a detached run that settles after its controller disposed keeps its duration', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.handle(run('r1'))
    store.handle({ type: 'controller:disposed', path: PATH })
    t = 50
    store.handle(success('r1'))
    expect(summary(store.mutations$.peek())).toEqual([['run'], ['success', 50]])
  })

  test('starts never closed (a core with no cancel event) are capped, oldest dropped', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    for (let i = 0; i < 1500; i++) store.handle(run(`r${i}`))
    expect(pendingRuns(store).size).toBe(1000)
    expect(pendingRuns(store).has('r0')).toBe(false)
    t = 7
    store.handle(success('r1499'))
    expect(store.mutations$.peek().at(-1)).toMatchObject({ kind: 'success', durationMs: 7 })
  })

  test('clearLogs drops pending runs, so a later cancel for one is ignored', () => {
    const store = new DevtoolsStore({ now: () => 0 })
    store.handle(run('r1'))
    store.clearLogs()
    store.handle(cancel('r1'))
    expect(store.mutations$.peek()).toEqual([])
    expect(pendingRuns(store).size).toBe(0)
  })

  test('a paused store still pairs, so a cancel after resume finds its run', () => {
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.pause()
    store.handle(run('r1'))
    store.resume()
    t = 40
    store.handle(cancel('r1', 'reset'))
    expect(summary(store.mutations$.peek())).toEqual([['cancel', 'reset', 40]])
  })
})

describe('against a real mutation', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  /** A root whose one mutation stays pending until the test resolves it, and honours its signal. */
  function setup(concurrency: 'latest-wins' | 'serial') {
    const gates = new Map<string, (v: string) => void>()
    const def = defineController((ctx) => ({
      search: createMutation(ctx, {
        id: 'search',
        concurrency,
        mutate: (q: string, { signal }: { signal: AbortSignal }) =>
          new Promise<string>((resolve, reject) => {
            gates.set(q, resolve)
            signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))
          }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })
    let t = 0
    const store = new DevtoolsStore({ now: () => t })
    store.attach(root)
    const search = (q: string) => root.api.search.run(q).catch(() => undefined)
    return { root, store, gates, search, at: (ms: number) => (t = ms) }
  }

  test('search-as-you-type: superseded runs close, the last settles in its own time', async () => {
    const { root, store, gates, search, at } = setup('latest-wins')
    search('a')
    at(100)
    search('ab')
    await flush()
    at(200)
    const last = search('abc')
    await flush()
    at(210)
    gates.get('abc')?.('done')
    await last
    expect(summary(store.mutations$.peek())).toEqual([
      ['run'],
      ['run'],
      ['cancel', 'superseded', 100],
      ['run'],
      ['cancel', 'superseded', 100],
      ['success', 10],
    ])
    expect(pendingRuns(store).size).toBe(0)
    root.dispose()
  })

  test('a serial reset closes the started run and ignores the queued ones', async () => {
    const { root, store, search } = setup('serial')
    const runs = [search('one'), search('two'), search('three')]
    root.api.search.reset()
    await Promise.all(runs)
    expect(summary(store.mutations$.peek())).toEqual([['run'], ['cancel', 'reset', 0]])
    const cancels = store.events$.peek().filter((e) => e.event.type === 'mutation:cancel')
    expect(cancels).toHaveLength(1)
    root.dispose()
  })
})
