/**
 * `mutation:cancel` on the devtools bus (SPEC §14.1). Every run whose plugin
 * event is `'cancel'` also sends one `mutation:cancel`, with the same `reason`
 * and the run id as its `causeId`. Without it the panel never learns a run
 * was cancelled, and pairs a later settle with the wrong start. A queued
 * `serial` run that never started sends one too, though no `mutation:run`
 * came before it.
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  createMutation,
  createRoot,
  type DebugEvent,
  defineController,
  definePlugin,
  isAbortError,
  type MutationEvent,
  queryEngine,
} from '../src'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
})
type Deferred<T> = {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A `mutate` that stays pending until the test settles it, and honours its signal. */
function gatedMutate() {
  const gates = new Map<string, Deferred<string>>()
  const mutate = (v: string, { signal }: { signal: AbortSignal }): Promise<string> => {
    const d = deferred<string>()
    gates.set(v, d)
    signal.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')), {
      once: true,
    })
    return d.promise
  }
  return { gates, mutate }
}

type Hooks = {
  concurrency: 'parallel' | 'latest-wins' | 'serial'
  onMutate?: (v: string) => void
  detached?: boolean
  mutate?: (v: string, ctx: { signal: AbortSignal }) => Promise<string>
}

/**
 * A root with one panel owning one mutation, a plugin that records every
 * `MutationEvent`, and a devtools subscriber that records every event.
 */
function setup(hooks: Hooks) {
  const plugin: MutationEvent[] = []
  const debug: DebugEvent[] = []
  const { gates, mutate } = gatedMutate()
  const panel = defineController((ctx) => ({
    save: createMutation(ctx, { id: 'doc/save', mutate, ...hooks }),
  }))
  const root = createRoot(
    defineController((ctx) => ({ panel: ctx.attach(panel, undefined) })),
    {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        definePlugin({
          name: 'recorder',
          setup: () => ({ onMutation: (e) => plugin.push(e) }),
        }),
      ],
    },
  )
  roots.push(root)
  root.debug.subscribe((e) => debug.push(e))
  /** `[runId, reason]` of every plugin `'cancel'`. */
  const pluginCancels = () =>
    plugin.filter((e) => e.phase === 'cancel').map((e) => [e.runId, e.reason])
  /** `[causeId, reason]` of every `mutation:cancel`. */
  const debugCancels = () =>
    debug.flatMap((e) => (e.type === 'mutation:cancel' ? [[e.causeId, e.reason]] : []))
  /** The run id plugins saw for the run with `variables`. */
  const runIdOf = (variables: string) => plugin.find((e) => e.variables === variables)?.runId
  return {
    gates,
    debug,
    pluginCancels,
    debugCancels,
    runIdOf,
    panel: root.api.panel,
    save: root.api.panel.api.save,
  }
}

describe('mutation:cancel — one per plugin cancel, with the same reason', () => {
  test("a latest-wins supersede sends reason 'superseded' under the superseded run's causeId", async () => {
    const t = setup({ concurrency: 'latest-wins' })
    const first = t.save.run('a').catch((e: unknown) => e)
    const second = t.save.run('ab')
    expect(isAbortError(await first)).toBe(true)
    t.gates.get('ab')?.resolve('saved')
    await second

    const a = t.runIdOf('a')
    expect(t.pluginCancels()).toEqual([[a, 'superseded']])
    expect(t.debugCancels()).toEqual(t.pluginCancels())
    // It closes the run that `mutation:run` opened under the same causeId,
    // with the same path and id.
    const run = t.debug.find((e) => e.type === 'mutation:run' && e.causeId === a)
    const cancel = t.debug.find((e) => e.type === 'mutation:cancel')
    expect(run).toMatchObject({ id: 'doc/save' })
    expect(cancel).toMatchObject({
      type: 'mutation:cancel',
      path: run?.type === 'mutation:run' ? run.path : [],
      id: 'doc/save',
      reason: 'superseded',
      causeId: a,
    })
    expect((cancel?.seq ?? 0) > (run?.seq ?? 0)).toBe(true)
  })

  test("reset() sends reason 'reset'", async () => {
    const t = setup({ concurrency: 'parallel' })
    const run = t.save.run('a').catch((e: unknown) => e)
    t.save.reset()
    expect(isAbortError(await run)).toBe(true)
    expect(t.pluginCancels()).toEqual([[t.runIdOf('a'), 'reset']])
    expect(t.debugCancels()).toEqual(t.pluginCancels())
  })

  test("the owning controller disposing sends reason 'dispose'", async () => {
    const t = setup({ concurrency: 'parallel' })
    const run = t.save.run('a').catch((e: unknown) => e)
    t.panel.dispose()
    expect(isAbortError(await run)).toBe(true)
    expect(t.pluginCancels()).toEqual([[t.runIdOf('a'), 'dispose']])
    expect(t.debugCancels()).toEqual(t.pluginCancels())
  })

  test('a queued serial run that never started still sends one, with no mutation:run before it', async () => {
    const t = setup({ concurrency: 'serial' })
    const one = t.save.run('one').catch((e: unknown) => e)
    const two = t.save.run('two').catch((e: unknown) => e)
    const three = t.save.run('three').catch((e: unknown) => e)
    t.save.reset()
    await Promise.all([one, two, three])

    // The queued runs are dropped at once; the active run's abort lands later.
    expect(t.pluginCancels()).toEqual([
      [t.runIdOf('two'), 'reset'],
      [t.runIdOf('three'), 'reset'],
      [t.runIdOf('one'), 'reset'],
    ])
    expect(t.debugCancels()).toEqual(t.pluginCancels())
    const started = t.debug.flatMap((e) => (e.type === 'mutation:run' ? [e.causeId] : []))
    expect(started).toEqual([t.runIdOf('one')])
  })

  test("the owner disposing sends reason 'dispose' for every queued run", async () => {
    const t = setup({ concurrency: 'serial' })
    const one = t.save.run('one').catch((e: unknown) => e)
    const two = t.save.run('two').catch((e: unknown) => e)
    t.panel.dispose()
    await Promise.all([one, two])
    expect(t.pluginCancels()).toEqual([
      [t.runIdOf('two'), 'dispose'],
      [t.runIdOf('one'), 'dispose'],
    ])
    expect(t.debugCancels()).toEqual(t.pluginCancels())
  })

  test('a queued run cancelled from its own onMutate sends one', async () => {
    let reset: () => void = () => {}
    const t = setup({
      concurrency: 'serial',
      onMutate: (v) => {
        if (v === 'two') reset()
      },
    })
    reset = () => t.save.reset()
    const one = t.save.run('one')
    const two = t.save.run('two').catch((e: unknown) => e)
    t.gates.get('one')?.resolve('1')
    await one
    expect(isAbortError(await two)).toBe(true)
    expect(t.pluginCancels()).toEqual([[t.runIdOf('two'), 'reset']])
    expect(t.debugCancels()).toEqual(t.pluginCancels())
  })
})

describe('mutation:cancel — none where plugins hear no cancel', () => {
  test('a run cancelled from its own onMutate, before it reported anything', async () => {
    let reset: () => void = () => {}
    const t = setup({ concurrency: 'parallel', onMutate: () => reset() })
    reset = () => t.save.reset()
    expect(isAbortError(await t.save.run('a').catch((e: unknown) => e))).toBe(true)
    expect(t.pluginCancels()).toEqual([])
    expect(t.debugCancels()).toEqual([])
  })

  test('a run whose work completed before the abort landed settles as a success', async () => {
    // `mutate` resolves, and the dispose lands before the run's continuation:
    // the write happened, so plugins hear `'success'`, and devtools no cancel.
    const work = deferred<string>()
    const t = setup({
      concurrency: 'parallel',
      // Not `async`: the window below is measured in microtask hops, as in
      // mutation.test.ts, "a run that COMPLETED before dispose…".
      mutate: () => work.promise,
    })
    const run = t.save.run('a').catch((e: unknown) => e)
    work.resolve('saved')
    await Promise.resolve()
    await Promise.resolve()
    expect(t.save.isPending.peek()).toBe(true) // the continuation has not run yet
    t.panel.dispose()
    expect(isAbortError(await run)).toBe(true)
    expect(t.runIdOf('a')).toBeDefined()
    expect(t.pluginCancels()).toEqual([])
    expect(t.debugCancels()).toEqual([])
  })

  test('a detached run the owner disposing leaves alone', async () => {
    const t = setup({ concurrency: 'parallel', detached: true })
    const run = t.save.run('a')
    t.panel.dispose()
    t.gates.get('a')?.resolve('saved')
    await expect(run).resolves.toBe('saved')
    expect(t.debugCancels()).toEqual([])
  })
})
