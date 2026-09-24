/**
 * Behaviour of `query/mutation.ts` that the other suites leave unpinned:
 *
 * - a `defineMutation` definition is recognised and takes the controller's
 *   hooks, while an inline spec (even one spread from a definition) is not a
 *   definition, and a non-string `id` is rejected;
 * - plugins see a mutation's `meta` (or `{}`), and the result or error of a
 *   run whose abort landed after its work had already settled;
 * - every lifecycle callback is optional, `onSettled` fires on both failure
 *   paths, and a throwing callback reaches the root's `onError` as `'mutation'`;
 * - an optimistic snapshot is consumed once, whichever of rollback and
 *   finalize comes first;
 * - an `AbortError` thrown by `mutate` itself is not retried;
 * - `reset()` clears `lastVariables`, and `dispose()` moves a pending run to
 *   idle and drops only its queued runs from the root's in-flight count;
 * - a run aborted before `mutate` returns reports `'cancel'` and rolls back;
 * - run ids come from `crypto.randomUUID`, and a runtime without `crypto`
 *   still runs;
 * - the internal factory works without an in-flight counter or devtools bus.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createMutation,
  createRoot,
  defineController,
  defineMutation,
  definePlugin,
  isAbortError,
  type MutationEvent,
  type MutationMeta,
  queryEngine,
  type Snapshot,
} from '../src'
import { createMutation as createBareMutation, isMutationDef } from '../src/query/mutation'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
  vi.unstubAllGlobals()
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

/** A pending write that rejects with an `AbortError` when its signal fires. */
function abortableGate<T>(gates: Array<Deferred<T>>, signal: AbortSignal): Promise<T> {
  const d = deferred<T>()
  gates.push(d)
  signal.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')), {
    once: true,
  })
  return d.promise
}

function mutationRecorder() {
  const events: MutationEvent[] = []
  const plugin = definePlugin({
    name: 'mutations',
    setup: () => ({ onMutation: (e) => events.push(e) }),
  })
  const phasesOf = (variables: unknown) =>
    events.filter((e) => e.variables === variables).map((e) => e.phase)
  return { plugin, events, phasesOf }
}

function spySnapshot() {
  return { rollback: vi.fn(), finalize: vi.fn() } satisfies Snapshot
}

describe('definitions', () => {
  test('createMutation(ctx, def, hooks) runs the controller hooks around the definition', async () => {
    const def = defineMutation({
      id: 'mutants-mutation/hooks',
      mutate: async (v: number) => v * 2,
    })
    const onMutate = vi.fn()
    const onSuccess = vi.fn()
    const onSettled = vi.fn()
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, def, { onMutate, onSuccess, onSettled }),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    expect(await root.api.m.run(3)).toBe(6)
    expect(onMutate).toHaveBeenCalledWith(3)
    expect(onSuccess).toHaveBeenCalledWith(6, 3)
    expect(onSettled).toHaveBeenCalledWith(6, undefined, 3)
  })

  test('only a value returned by defineMutation counts as a definition', () => {
    const def = defineMutation({ id: 'mutants-mutation/brand', mutate: async () => 1 })
    expect(isMutationDef(def)).toBe(true)
    // Spreading a definition makes an inline spec: the brand stays behind.
    expect(isMutationDef({ ...def })).toBe(false)
    expect(isMutationDef({ id: 'inline', mutate: async () => 1 })).toBe(false)
    expect(isMutationDef(null)).toBe(false)
    expect(isMutationDef(undefined)).toBe(false)
    expect(isMutationDef('mutation')).toBe(false)
    expect(isMutationDef(() => 'mutation')).toBe(false)
  })

  test('defineMutation rejects an id that is not a string', () => {
    const mutate = async () => 1
    expect(() => defineMutation({ id: 42 as unknown as string, mutate })).toThrow('non-empty `id`')
    expect(() => defineMutation({ id: undefined as unknown as string, mutate })).toThrow(
      'non-empty `id`',
    )
  })
})

describe('what plugins see', () => {
  test('each event carries the mutation meta, or an empty object when it has none', async () => {
    const { plugin, events } = mutationRecorder()
    const meta = { tag: 'orders' } as MutationMeta
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          tagged: createMutation(ctx, { id: 'tagged', meta, mutate: async () => 1 }),
          plain: createMutation(ctx, { id: 'plain', mutate: async () => 2 }),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.api.tagged.run()
    await root.api.plain.run()
    const metaOf = (id: string) =>
      events.filter((e) => e.mutation.id === id).map((e) => e.mutation.meta)
    expect(metaOf('tagged')).toEqual([{ tag: 'orders' }, { tag: 'orders' }])
    expect(metaOf('plain')).toEqual([{}, {}])
  })

  test('a latest-wins run that completed just before its supersede reports its result and stays rolled back', async () => {
    const { plugin, events, phasesOf } = mutationRecorder()
    const gates = { one: deferred<string>(), two: deferred<string>() }
    const snapshots: Partial<Record<'one' | 'two', ReturnType<typeof spySnapshot>>> = {}
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          save: createMutation(ctx, {
            concurrency: 'latest-wins',
            // Deliberately not `async`: the window below is measured in hops.
            mutate: (v: 'one' | 'two') => gates[v].promise,
            onMutate: (v: 'one' | 'two') => {
              const snapshot = spySnapshot()
              snapshots[v] = snapshot
              return snapshot
            },
          }),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const { save } = root.api
    const first = save.run('one').catch((e: unknown) => e)
    gates.one.resolve('saved-one') // the server takes run one…
    // …and run two supersedes it after `raceAbort` resolved but before run
    // one's continuation ran.
    await Promise.resolve()
    await Promise.resolve()
    expect(phasesOf('one')).toEqual(['start'])
    const second = save.run('two')

    expect(isAbortError(await first)).toBe(true)
    const outcome = events.filter((e) => e.variables === 'one')
    expect(outcome.map((e) => e.phase)).toEqual(['start', 'success'])
    expect(outcome[1]?.result).toBe('saved-one')
    // The supersede rolled run one back. Committing it afterwards would
    // resurrect a value run two has already replaced.
    expect(snapshots.one?.rollback).toHaveBeenCalledTimes(1)
    expect(snapshots.one?.finalize).not.toHaveBeenCalled()

    gates.two.resolve('saved-two')
    expect(await second).toBe('saved-two')
    expect(snapshots.two?.finalize).toHaveBeenCalledTimes(1)
  })

  test('a latest-wins run that failed just before its supersede reports the error, yet its caller sees an abort', async () => {
    const { plugin, events, phasesOf } = mutationRecorder()
    const gates = { one: deferred<string>(), two: deferred<string>() }
    const onError = vi.fn()
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          save: createMutation(ctx, {
            concurrency: 'latest-wins',
            mutate: (v: 'one' | 'two') => gates[v].promise,
            onError,
          }),
        })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const { save } = root.api
    const first = save.run('one').catch((e: unknown) => e)
    const rejected = new Error('rejected by the server')
    gates.one.reject(rejected)
    await Promise.resolve()
    await Promise.resolve()
    expect(phasesOf('one')).toEqual(['start'])
    const second = save.run('two')

    // Whoever awaited run one walked away, so it hears an abort…
    expect(isAbortError(await first)).toBe(true)
    // …but the work failed, and plugins are told so rather than "cancelled".
    const outcome = events.filter((e) => e.variables === 'one')
    expect(outcome.map((e) => e.phase)).toEqual(['start', 'error'])
    expect(outcome[1]?.error).toBe(rejected)
    // `error` and `onError` belong to runs someone still awaits.
    expect(save.error.peek()).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()

    gates.two.resolve('saved-two')
    expect(await second).toBe('saved-two')
  })
})

describe('lifecycle callbacks', () => {
  test('a mutation without callbacks reports nothing to the root onError, whatever the outcome', async () => {
    const onError = vi.fn()
    let fail = false
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          plain: createMutation(ctx, {
            mutate: async () => {
              if (fail) throw new Error('write failed')
              return 'ok'
            },
          }),
          guarded: createMutation(ctx, {
            mutate: async () => 'never',
            onMutate: () => {
              throw new Error('optimistic setup failed')
            },
          }),
        })),
        { queries: queryEngine(), deps: {}, onError },
      ),
    )
    expect(await root.api.plain.run()).toBe('ok')
    fail = true
    await expect(root.api.plain.run()).rejects.toThrow('write failed')
    await expect(root.api.guarded.run()).rejects.toThrow('optimistic setup failed')
    expect(onError).not.toHaveBeenCalled()
  })

  test('when onMutate throws, onError and onSettled both hear it, and their own throws reach the root as mutation errors', async () => {
    const rootOnError = vi.fn()
    const setupFailed = new Error('optimistic setup failed')
    const mutate = vi.fn(async (_v: number) => 'never')
    const onError = vi.fn((_err: unknown, _v: number, _s: Snapshot | undefined) => {
      throw new Error('onError broke')
    })
    const onSettled = vi.fn((_r: string | undefined, _err: unknown, _v: number) => {
      throw new Error('onSettled broke')
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, {
            mutate,
            onMutate: () => {
              throw setupFailed
            },
            onError,
            onSettled,
          }),
        })),
        { queries: queryEngine(), deps: {}, onError: rootOnError },
      ),
    )
    await expect(root.api.m.run(5)).rejects.toBe(setupFailed)
    expect(mutate).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(setupFailed, 5, undefined)
    expect(onSettled).toHaveBeenCalledWith(undefined, setupFailed, 5)
    expect(rootOnError.mock.calls.map(([err, ctx]) => [(err as Error).message, ctx.kind])).toEqual([
      ['onError broke', 'mutation'],
      ['onSettled broke', 'mutation'],
    ])
  })

  test('when mutate fails, onError and onSettled both hear it, and their own throws reach the root as mutation errors', async () => {
    const rootOnError = vi.fn()
    const writeFailed = new Error('write failed')
    const onError = vi.fn((_err: unknown, _v: number, _s: Snapshot | undefined) => {
      throw new Error('onError broke')
    })
    const onSettled = vi.fn((_r: string | undefined, _err: unknown, _v: number) => {
      throw new Error('onSettled broke')
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, {
            mutate: async (_v: number): Promise<string> => {
              throw writeFailed
            },
            onError,
            onSettled,
          }),
        })),
        { queries: queryEngine(), deps: {}, onError: rootOnError },
      ),
    )
    await expect(root.api.m.run(5)).rejects.toBe(writeFailed)
    expect(onError).toHaveBeenCalledWith(writeFailed, 5, undefined)
    expect(onSettled).toHaveBeenCalledWith(undefined, writeFailed, 5)
    expect(rootOnError.mock.calls.map(([err, ctx]) => [(err as Error).message, ctx.kind])).toEqual([
      ['onError broke', 'mutation'],
      ['onSettled broke', 'mutation'],
    ])
  })

  test('a throwing onSettled after a success reaches the root as a mutation error', async () => {
    const rootOnError = vi.fn()
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, {
            mutate: async (v: number) => v + 1,
            onSettled: () => {
              throw new Error('onSettled broke')
            },
          }),
        })),
        { queries: queryEngine(), deps: {}, onError: rootOnError },
      ),
    )
    expect(await root.api.m.run(1)).toBe(2)
    expect(root.api.m.status.value).toBe('success')
    expect(rootOnError).toHaveBeenCalledTimes(1)
    expect(rootOnError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'onSettled broke' }),
      expect.objectContaining({ kind: 'mutation' }),
    )
  })
})

describe('optimistic snapshots', () => {
  test('a run that completed before dispose commits its snapshot and never rolls it back', async () => {
    const d = deferred<string>()
    const snapshot = spySnapshot()
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          // Deliberately not `async`: the window below is measured in hops.
          save: createMutation(ctx, { mutate: () => d.promise, onMutate: () => snapshot }),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const settled = root.api.save.run().catch((e: unknown) => e)
    d.resolve('accepted')
    await Promise.resolve()
    await Promise.resolve()
    expect(root.api.save.isPending.peek()).toBe(true) // the continuation has not run yet
    root.api.save.dispose()

    expect(isAbortError(await settled)).toBe(true)
    expect(snapshot.finalize).toHaveBeenCalledTimes(1)
    // The cancellation path that follows must not undo the commit.
    expect(snapshot.rollback).not.toHaveBeenCalled()
  })

  test('a run aborted before its mutate returns reports cancel and rolls its snapshot back', async () => {
    const { plugin, events } = mutationRecorder()
    const snapshot = spySnapshot()
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const m = createMutation(ctx, {
            mutate: (v: number) => {
              m.reset() // the run is aborted before `mutate` even returns
              return Promise.resolve(v)
            },
            onMutate: () => snapshot,
          })
          return { m }
        }),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const err = await root.api.m.run(1).catch((e: unknown) => e)
    expect(isAbortError(err)).toBe(true)
    // Aborted before the work was ever observed to settle: a cancellation, so
    // a queue plugin keeps the entry rather than recording a success.
    expect(events.map((e) => e.phase)).toEqual(['start', 'cancel'])
    expect(snapshot.rollback).toHaveBeenCalledTimes(1)
    expect(snapshot.finalize).not.toHaveBeenCalled()
  })
})

describe('retries', () => {
  test('an AbortError thrown by mutate itself is not retried', async () => {
    let calls = 0
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, {
            retry: 3,
            retryDelay: 0,
            mutate: async (): Promise<string> => {
              calls += 1
              throw new DOMException('request aborted', 'AbortError')
            },
          }),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const err = await root.api.m.run().catch((e: unknown) => e)
    expect(isAbortError(err)).toBe(true)
    expect(calls).toBe(1)
  })
})

describe('reset and dispose', () => {
  test('reset() clears lastVariables along with the rest of the state', async () => {
    const root = keep(
      createRoot(
        defineController((ctx) => ({ m: createMutation(ctx, { mutate: async (v: number) => v }) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const { m } = root.api
    await m.run(7)
    expect(m.lastVariables.value).toBe(7)
    m.reset()
    expect(m.lastVariables.value).toBeUndefined()
    expect(m.status.value).toBe('idle')
  })

  test('dispose() moves a pending mutation to idle, and it stays idle once the run settles', async () => {
    const gates: Array<Deferred<string>> = []
    const root = createRoot(
      defineController((ctx) => ({
        m: createMutation(ctx, {
          mutate: (_v: number, { signal }) => abortableGate(gates, signal),
        }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    const { m } = root.api
    const run = m.run(1).catch((e: unknown) => e)
    expect(m.status.value).toBe('pending')
    root.dispose()
    expect(m.status.value).toBe('idle')
    expect(isAbortError(await run)).toBe(true)
    expect(m.status.value).toBe('idle')
  })

  test('disposing a serial mutation drops only its own runs from the root in-flight count', async () => {
    const other = deferred<string>()
    const gates: Array<Deferred<string>> = []
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          other: createMutation(ctx, { mutate: () => other.promise }),
          queue: createMutation(ctx, {
            concurrency: 'serial',
            mutate: (_v: number, { signal }) => abortableGate(gates, signal),
          }),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const otherRun = root.api.other.run()
    const active = root.api.queue.run(1).catch((e: unknown) => e)
    const queued = [2, 3].map((v) => root.api.queue.run(v).catch((e: unknown) => e))
    root.api.queue.dispose()
    for (const run of [active, ...queued]) expect(isAbortError(await run)).toBe(true)

    let idle = false
    const idleWait = root.waitForIdle().then(() => {
      idle = true
    })
    await flush()
    expect(idle).toBe(false) // `other` is still in flight
    other.resolve('done')
    expect(await otherRun).toBe('done')
    await idleWait
    expect(idle).toBe(true)
  })
})

describe('run ids', () => {
  test('run ids come from crypto.randomUUID when the runtime has it', async () => {
    const { plugin, events } = mutationRecorder()
    const root = keep(
      createRoot(
        defineController((ctx) => ({ m: createMutation(ctx, { mutate: async (v: number) => v }) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    let n = 0
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++n}` })
    await root.api.m.run(1)
    await root.api.m.run(2)
    expect(events.map((e) => e.runId)).toEqual(['uuid-1', 'uuid-1', 'uuid-2', 'uuid-2'])
  })

  test('a runtime with no crypto at all still runs, on a fallback id', async () => {
    const { plugin, events } = mutationRecorder()
    const root = keep(
      createRoot(
        defineController((ctx) => ({ m: createMutation(ctx, { mutate: async (v: number) => v }) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    vi.stubGlobal('crypto', undefined)
    expect(await root.api.m.run(1)).toBe(1)
    expect(events.map((e) => e.phase)).toEqual(['start', 'success'])
    expect(events[0]?.runId).toMatch(/^[0-9a-z]+-[0-9a-z]+$/)
  })
})

describe('the internal factory', () => {
  test('runs, queues, resets and disposes with no in-flight counter, devtools bus or plugin hooks', async () => {
    const gates: Array<Deferred<string>> = []
    const m = createBareMutation<number, string>(
      {
        concurrency: 'serial',
        mutate: (_v, { signal }) => abortableGate(gates, signal),
      },
      undefined,
      ['bare'],
    )
    const one = m.run(1)
    const two = m.run(2) // queued behind one
    await flush()
    expect(gates).toHaveLength(1)
    gates[0]?.resolve('one')
    expect(await one).toBe('one')
    await flush()
    expect(gates).toHaveLength(2)
    gates[1]?.resolve('two')
    expect(await two).toBe('two')
    expect(m.status.value).toBe('success')

    const reset = [3, 4].map((v) => m.run(v).catch((e: unknown) => e))
    m.reset()
    for (const run of reset) expect(isAbortError(await run)).toBe(true)
    expect(m.status.value).toBe('idle')

    const disposed = [5, 6].map((v) => m.run(v).catch((e: unknown) => e))
    m.dispose()
    for (const run of disposed) expect(isAbortError(await run)).toBe(true)
    expect(m.status.value).toBe('idle')
    expect(m.isPending.value).toBe(false)
  })
})
