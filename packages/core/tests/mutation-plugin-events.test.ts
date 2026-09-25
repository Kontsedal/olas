/**
 * What a mutation run tells the root's plugins beyond `'start'` and one
 * outcome (SPEC §13.1):
 *
 * - a `'cancel'` carries a `reason`, so a plugin can tell the app dropping a
 *   run on purpose (`'superseded'`, `'reset'`) from the screen that started it
 *   going away (`'dispose'`);
 * - a `serial` run that waits behind another reports `'queued'` when
 *   `run(...)` is called, under the `runId` it later starts with, and every
 *   queued run reports exactly one outcome, whether it starts or not.
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  createMutation,
  createRoot,
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
const keep = <T extends { dispose(): void }>(r: T): T => {
  roots.push(r)
  return r
}
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

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

function mutationRecorder() {
  const events: MutationEvent[] = []
  const plugin = definePlugin({
    name: 'mutations',
    setup: () => ({ onMutation: (e) => events.push(e) }),
  })
  /** `[phase, reason]` of every event for one run's variables. */
  const stepsOf = (variables: unknown) =>
    events
      .filter((e) => e.variables === variables)
      .map((e) => (e.reason === undefined ? [e.phase] : [e.phase, e.reason]))
  return { plugin, events, stepsOf }
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

describe("a 'cancel' says why", () => {
  test("a latest-wins supersede reports reason 'superseded'", async () => {
    const { plugin, stepsOf } = mutationRecorder()
    const { gates, mutate } = gatedMutate()
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          save: createMutation(ctx, { concurrency: 'latest-wins', mutate }),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const first = root.api.save.run('a').catch((e: unknown) => e)
    const second = root.api.save.run('ab')
    expect(isAbortError(await first)).toBe(true)
    gates.get('ab')?.resolve('saved')
    await second
    expect(stepsOf('a')).toEqual([['start'], ['cancel', 'superseded']])
    expect(stepsOf('ab')).toEqual([['start'], ['success']])
  })

  test("reset() reports reason 'reset'", async () => {
    const { plugin, stepsOf } = mutationRecorder()
    const { mutate } = gatedMutate()
    const root = keep(
      createRoot(
        defineController((ctx) => ({ save: createMutation(ctx, { mutate }) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const run = root.api.save.run('a').catch((e: unknown) => e)
    root.api.save.reset()
    expect(isAbortError(await run)).toBe(true)
    expect(stepsOf('a')).toEqual([['start'], ['cancel', 'reset']])
  })

  test("the owning controller disposing reports reason 'dispose'", async () => {
    const { plugin, stepsOf } = mutationRecorder()
    const { mutate } = gatedMutate()
    const panel = defineController((ctx) => ({ save: createMutation(ctx, { mutate }) }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ panel: ctx.attach(panel, undefined) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const run = root.api.panel.api.save.run('a').catch((e: unknown) => e)
    root.api.panel.dispose()
    expect(isAbortError(await run)).toBe(true)
    expect(stepsOf('a')).toEqual([['start'], ['cancel', 'dispose']])
  })

  test('a success or a failure carries no reason', async () => {
    const { plugin, events } = mutationRecorder()
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          save: createMutation(ctx, {
            mutate: async (v: string) => {
              if (v === 'bad') throw new Error('nope')
              return v
            },
          }),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.api.save.run('good')
    await root.api.save.run('bad').catch(() => {})
    expect(events.map((e) => e.phase)).toEqual(['start', 'success', 'start', 'error'])
    expect(events.every((e) => !('reason' in e))).toBe(true)
  })
})

describe("a serial run that waits reports 'queued'", () => {
  function serialRoot(hooks: { onMutate?: (v: string) => void; detached?: boolean } = {}) {
    const recorder = mutationRecorder()
    const { gates, mutate } = gatedMutate()
    const panel = defineController((ctx) => ({
      save: createMutation(ctx, { concurrency: 'serial', mutate, ...hooks }),
    }))
    const root = keep(
      createRoot(
        defineController((ctx) => ({ panel: ctx.attach(panel, undefined) })),
        { queries: queryEngine(), deps: {}, plugins: [recorder.plugin] },
      ),
    )
    return { ...recorder, gates, panel: root.api.panel, save: root.api.panel.api.save }
  }

  test('when run() is called, under the runId it later starts with', async () => {
    const { events, stepsOf, gates, save } = serialRoot()
    const one = save.run('one')
    const two = save.run('two')
    const three = save.run('three')
    // Reported synchronously, in call order: a queue plugin can persist all
    // three before the first request settles.
    expect(events.map((e) => [e.phase, e.variables])).toEqual([
      ['start', 'one'],
      ['queued', 'two'],
      ['queued', 'three'],
    ])
    gates.get('one')?.resolve('1')
    await one
    await flush()
    gates.get('two')?.resolve('2')
    await two
    await flush()
    gates.get('three')?.resolve('3')
    await three
    expect(stepsOf('one')).toEqual([['start'], ['success']])
    expect(stepsOf('two')).toEqual([['queued'], ['start'], ['success']])
    expect(stepsOf('three')).toEqual([['queued'], ['start'], ['success']])
    for (const v of ['two', 'three']) {
      const ids = new Set(events.filter((e) => e.variables === v).map((e) => e.runId))
      expect(ids.size, `${v} keeps one runId`).toBe(1)
    }
  })

  test('a serial run with nothing ahead of it is not queued', async () => {
    const { stepsOf, gates, save } = serialRoot()
    const one = save.run('one')
    gates.get('one')?.resolve('1')
    await one
    expect(stepsOf('one')).toEqual([['start'], ['success']])
  })

  test("reset() cancels the queued runs with reason 'reset'", async () => {
    const { stepsOf, save } = serialRoot()
    const one = save.run('one').catch((e: unknown) => e)
    const two = save.run('two').catch((e: unknown) => e)
    save.reset()
    expect(isAbortError(await one)).toBe(true)
    expect(isAbortError(await two)).toBe(true)
    expect(stepsOf('one')).toEqual([['start'], ['cancel', 'reset']])
    expect(stepsOf('two')).toEqual([['queued'], ['cancel', 'reset']])
  })

  test("the owner disposing cancels the queued runs with reason 'dispose'", async () => {
    const { stepsOf, panel, save } = serialRoot()
    const one = save.run('one').catch((e: unknown) => e)
    const two = save.run('two').catch((e: unknown) => e)
    panel.dispose()
    expect(isAbortError(await one)).toBe(true)
    expect(isAbortError(await two)).toBe(true)
    expect(stepsOf('one')).toEqual([['start'], ['cancel', 'dispose']])
    expect(stepsOf('two')).toEqual([['queued'], ['cancel', 'dispose']])
  })

  test("a queued run whose onMutate throws reports 'error'", async () => {
    const { events, stepsOf, gates, save } = serialRoot({
      onMutate: (v) => {
        if (v === 'two') throw new Error('optimistic setup failed')
      },
    })
    const one = save.run('one')
    const two = save.run('two').catch((e: unknown) => e)
    gates.get('one')?.resolve('1')
    await one
    expect(((await two) as Error).message).toBe('optimistic setup failed')
    // It never started, and it still reports one outcome.
    expect(stepsOf('two')).toEqual([['queued'], ['error']])
    const outcome = events.find((e) => e.variables === 'two' && e.phase === 'error')
    expect((outcome?.error as Error).message).toBe('optimistic setup failed')
  })

  test("a queued run cancelled from its own onMutate reports 'cancel'", async () => {
    let reset: () => void = () => {}
    const { stepsOf, gates, save } = serialRoot({
      onMutate: (v) => {
        if (v === 'two') reset()
      },
    })
    reset = () => save.reset()
    const one = save.run('one')
    const two = save.run('two').catch((e: unknown) => e)
    gates.get('one')?.resolve('1')
    await one
    expect(isAbortError(await two)).toBe(true)
    expect(stepsOf('two')).toEqual([['queued'], ['cancel', 'reset']])
  })

  test('a detached queue drains after dispose: queued, then start, then the outcome', async () => {
    const { stepsOf, gates, panel, save } = serialRoot({ detached: true })
    const one = save.run('one')
    const two = save.run('two')
    panel.dispose()
    gates.get('one')?.resolve('1')
    await one
    await flush()
    gates.get('two')?.resolve('2')
    await two
    expect(stepsOf('two')).toEqual([['queued'], ['start'], ['success']])
  })
})
