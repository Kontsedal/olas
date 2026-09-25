/**
 * `query/mutation.ts` paths the main suites leave dark: the disposed-error
 * message for an anonymous root mutation, `defineMutation`'s id check, a
 * `latest-wins` run that completes in the window before its supersede, retry
 * and delay functions, a throwing lifecycle callback, `reset()` after
 * dispose, the run-id fallback, a run cancelled from inside its own `mutate`,
 * and a failing queued `serial` run.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  bindQuery,
  createMutation,
  createQuery,
  createRoot,
  defineController,
  defineMutation,
  definePlugin,
  defineQuery,
  isAbortError,
  MutationDisposedError,
  type MutationEvent,
  queryEngine,
} from '../src'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
  vi.useRealTimers()
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

function mutationRecorder() {
  const events: MutationEvent[] = []
  const plugin = definePlugin({
    name: 'mutations',
    setup: () => ({ onMutation: (e) => events.push(e) }),
  })
  return { plugin, events }
}

describe('MutationDisposedError', () => {
  test('names an anonymous mutation and falls back to <root> for an empty path', () => {
    const err = new MutationDisposedError(undefined, [])
    expect(err.name).toBe('MutationDisposedError')
    expect(err.message).toContain('(anonymous)')
    expect(err.message).toContain('<root>')
    expect(err.mutationId).toBeUndefined()
    expect(err.controllerPath).toEqual([])
  })

  test('an inline mutation without an id rejects with it after dispose', async () => {
    const mutate = vi.fn(async () => 1)
    const root = createRoot(
      defineController((ctx) => ({ m: createMutation(ctx, { mutate }) })),
      {
        queries: queryEngine(),
        deps: {},
      },
    )
    const { m } = root.api
    root.dispose()
    const err = await m.run().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MutationDisposedError)
    expect((err as MutationDisposedError).message).toContain('(anonymous) at root')
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('defineMutation', () => {
  test('requires a non-empty id', () => {
    expect(() => defineMutation({ id: '', mutate: async () => 1 })).toThrow('non-empty `id`')
  })
})

describe('latest-wins', () => {
  test('a run that completes just before its supersede reports success, and its snapshot stays rolled back', async () => {
    const { plugin, events } = mutationRecorder()
    const q = defineQuery({
      id: 'cov-mutation/late',
      key: () => ['doc'],
      fetcher: async () => 'server',
    })
    const gates: Record<string, Deferred<string>> = {
      one: deferred<string>(),
      two: deferred<string>(),
    }
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const doc = bindQuery(ctx, q)
          return {
            read: createQuery(ctx, q),
            save: createMutation(ctx, {
              concurrency: 'latest-wins',
              // Deliberately not `async`: the window below is measured in hops.
              mutate: (v: string) => (gates[v] as Deferred<string>).promise,
              onMutate: (v: string) => doc.setData(() => `optimistic-${v}`),
            }),
          }
        }),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    const { read, save } = root.api
    await read.firstValue()
    let firstSettled = false
    const first = save.run('one').catch((e: unknown) => e)
    void first.then(() => {
      firstSettled = true
    })
    expect(read.data.value).toBe('optimistic-one')

    gates.one?.resolve('saved-one') // the server takes run one…
    // …and run two supersedes it in the window after `raceAbort` resolved but
    // before run one's continuation ran (see mutation.test.ts, "a run that
    // COMPLETED before dispose").
    await Promise.resolve()
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    const second = save.run('two')
    expect(read.data.value).toBe('optimistic-two') // one rolled back, two applied on top

    expect(isAbortError(await first)).toBe(true)
    // Run one settled as a success: it must not be replayed as cancelled…
    expect(events.filter((e) => e.variables === 'one').map((e) => e.phase)).toEqual([
      'start',
      'success',
    ])
    // …and committing its snapshot, already rolled back by the supersede, is a no-op.
    expect(read.data.value).toBe('optimistic-two')

    gates.two?.resolve('saved-two')
    expect(await second).toBe('saved-two')
    expect(read.hasPendingMutations.value).toBe(false)
    expect(save.data.value).toBe('saved-two')
  })
})

describe('retries', () => {
  test('retry and retryDelay as functions decide each attempt and its backoff', async () => {
    vi.useFakeTimers()
    let calls = 0
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, {
            mutate: async (v: number) => {
              calls += 1
              if (calls < 3) throw new Error('flaky')
              return v * 10
            },
            retry: (attempt, err) => attempt < 2 && (err as Error).message === 'flaky',
            retryDelay: (attempt) => (attempt + 1) * 100,
          }),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const run = root.api.m.run(4)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(3)
    expect(await run).toBe(40)
  })
})

describe('callbacks and control after dispose', () => {
  test('a throwing onSuccess is reported to onError and the run still resolves', async () => {
    const onError = vi.fn()
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, {
            mutate: async () => 'done',
            onSuccess: () => {
              throw new Error('callback broke')
            },
          }),
        })),
        { queries: queryEngine(), deps: {}, onError },
      ),
    )
    expect(await root.api.m.run()).toBe('done')
    expect(root.api.m.status.value).toBe('success')
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'callback broke' }),
      expect.objectContaining({ kind: 'mutation', controllerPath: ['root'] }),
    )
  })

  test('reset after the owning controller is disposed leaves the state alone', async () => {
    const root = createRoot(
      defineController((ctx) => ({ m: createMutation(ctx, { mutate: async () => 'x' }) })),
      { queries: queryEngine(), deps: {} },
    )
    const { m } = root.api
    await m.run()
    root.dispose()
    m.reset()
    expect(m.data.value).toBe('x')
    expect(m.status.value).toBe('success')
  })
})

describe('run ids', () => {
  test('without crypto.randomUUID, run ids fall back to a timestamp-random id', async () => {
    vi.stubGlobal('crypto', {})
    const { plugin, events } = mutationRecorder()
    const root = keep(
      createRoot(
        defineController((ctx) => ({ m: createMutation(ctx, { mutate: async (v: number) => v }) })),
        { queries: queryEngine(), deps: {}, plugins: [plugin] },
      ),
    )
    await root.api.m.run(1)
    await root.api.m.run(2)
    const ids = [...new Set(events.map((e) => e.runId))]
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/)
  })
})

describe('cancellation from inside mutate', () => {
  test('a mutate that resets its own mutation synchronously rejects with an AbortError', async () => {
    const onSuccess = vi.fn()
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const m = createMutation(ctx, {
            mutate: (v: number) => {
              m.reset() // the run is aborted before `mutate` even returns
              return Promise.resolve(v)
            },
            onSuccess,
          })
          return { m }
        }),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const err = await root.api.m.run(1).catch((e: unknown) => e)
    expect(isAbortError(err)).toBe(true)
    expect(root.api.m.status.value).toBe('idle')
    expect(root.api.m.data.value).toBeUndefined()
    expect(onSuccess).not.toHaveBeenCalled()
  })
})

describe('serial', () => {
  test('a queued run that fails rejects its caller and the queue moves on', async () => {
    const gates: Array<Deferred<string>> = []
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          m: createMutation(ctx, {
            concurrency: 'serial',
            mutate: (_v: number) => {
              const d = deferred<string>()
              gates.push(d)
              return d.promise
            },
          }),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const { m } = root.api
    const one = m.run(1)
    const two = m.run(2).catch((e: unknown) => e)
    const three = m.run(3)
    await flush()
    expect(gates).toHaveLength(1)
    gates[0]?.resolve('first')
    expect(await one).toBe('first')
    await flush()
    expect(gates).toHaveLength(2)
    gates[1]?.reject(new Error('second failed'))
    expect(((await two) as Error).message).toBe('second failed')
    await flush()
    expect(gates).toHaveLength(3)
    gates[2]?.resolve('third')
    expect(await three).toBe('third')
    expect(m.status.value).toBe('success')
  })
})
