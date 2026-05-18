import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import { isAbortError } from '../src/utils'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  let reject: (err: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ctx.mutation — happy paths', () => {
  test('run() resolves with the mutator result and updates data/isPending', async () => {
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async (v: { x: number }) => v.x * 2,
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.save.isPending.value).toBe(false)
    const promise = root.save.run({ x: 5 })
    expect(root.save.isPending.value).toBe(true)
    expect(root.save.lastVariables.value).toEqual({ x: 5 })
    const result = await promise
    expect(result).toBe(10)
    expect(root.save.data.value).toBe(10)
    expect(root.save.isPending.value).toBe(false)
    expect(root.save.error.value).toBeUndefined()
    root.dispose()
  })

  test('errors are captured into .error and rejected from run()', async () => {
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async () => {
          throw new Error('save failed')
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await expect(root.save.run(undefined)).rejects.toThrow('save failed')
    expect((root.save.error.value as Error).message).toBe('save failed')
    expect(root.save.isPending.value).toBe(false)
    root.dispose()
  })

  test('reset clears data/error/lastVariables and aborts in-flight', async () => {
    const d = deferred<number>()
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async () => d.promise,
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const promise = root.save.run(undefined).catch((e) => e)
    expect(root.save.isPending.value).toBe(true)
    root.save.reset()
    expect(root.save.isPending.value).toBe(false)
    expect(root.save.lastVariables.value).toBeUndefined()
    d.resolve(1)
    const result = await promise
    expect(isAbortError(result)).toBe(true)
    root.dispose()
  })
})

describe('ctx.mutation — concurrency: parallel (default)', () => {
  test('multiple runs are independent; isPending tracks any in-flight', async () => {
    const ds = [deferred<string>(), deferred<string>(), deferred<string>()]
    let i = 0
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async () => ds[i++]!.promise,
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const p1 = root.save.run(undefined)
    const p2 = root.save.run(undefined)
    const p3 = root.save.run(undefined)
    expect(root.save.isPending.value).toBe(true)

    ds[1]!.resolve('b')
    await flush()
    expect(root.save.isPending.value).toBe(true) // still 0 and 2 in flight
    expect(root.save.data.value).toBe('b')

    ds[0]!.resolve('a')
    ds[2]!.resolve('c')
    await Promise.all([p1, p2, p3])
    expect(root.save.isPending.value).toBe(false)
    root.dispose()
  })
})

describe('ctx.mutation — concurrency: latest-wins', () => {
  test('new run aborts the previous; superseded run rejects with AbortError', async () => {
    const ds = [deferred<string>(), deferred<string>()]
    let i = 0
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async (_: void, sig) => {
          const d = ds[i++]!
          sig.addEventListener('abort', () => d.reject(new DOMException('Aborted', 'AbortError')))
          return d.promise
        },
        concurrency: 'latest-wins',
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const p1 = root.save.run(undefined).catch((e) => e)
    const p2 = root.save.run(undefined)

    ds[1]!.resolve('second')
    expect(await p2).toBe('second')

    const e1 = await p1
    expect(isAbortError(e1)).toBe(true)
    expect(root.save.error.value).toBeUndefined() // supersede ≠ real failure
    root.dispose()
  })

  test('onMutate snapshot is rolled back on supersede', async () => {
    const q = defineQuery({
      key: () => ['x'],
      fetcher: async () => 1,
    })
    let initialFetchDone = false
    const def = defineController((ctx) => {
      const x = ctx.use(q)
      const save = ctx.mutation({
        mutate: async (v: number) =>
          new Promise<number>((resolve) => setTimeout(() => resolve(v), 50)),
        onMutate: (v) => q.setData(() => v),
        concurrency: 'latest-wins',
      })
      return { x, save }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    initialFetchDone = true
    void initialFetchDone

    const p1 = root.save.run(10).catch((e) => e)
    expect(root.x.data.value).toBe(10)
    const p2 = root.save.run(20)
    expect(root.x.data.value).toBe(20)

    const e1 = await p1
    expect(isAbortError(e1)).toBe(true)
    // After supersede, snapshot of run1 rolled back → state should match run2's
    expect(root.x.data.value).toBe(20)

    await p2.catch(() => {})
    root.dispose()
  })

  test('onError/onSettled are NOT invoked on supersede', async () => {
    const onError = vi.fn()
    const onSettled = vi.fn()
    const ds = [deferred<void>(), deferred<void>()]
    let i = 0
    const def = defineController((ctx) => ({
      save: ctx.mutation<void, void>({
        mutate: async () => {
          const d = ds[i++]!
          return d.promise
        },
        onError,
        onSettled,
        concurrency: 'latest-wins',
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const p1 = root.save.run().catch(() => {})
    const p2 = root.save.run()
    ds[1]!.resolve()
    await p2
    await p1
    // Only the second run's onSettled fires (success).
    expect(onError).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledTimes(1)
    root.dispose()
  })
})

describe('ctx.mutation — concurrency: serial', () => {
  test('queued runs execute one at a time in order', async () => {
    const order: number[] = []
    const ds = [deferred<number>(), deferred<number>(), deferred<number>()]
    let i = 0
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async (v: number) => {
          order.push(v)
          return ds[i++]!.promise
        },
        concurrency: 'serial',
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const p1 = root.save.run(1)
    const p2 = root.save.run(2)
    const p3 = root.save.run(3)
    expect(order).toEqual([1]) // 2 and 3 are queued

    ds[0]!.resolve(1)
    await p1
    expect(order).toEqual([1, 2])

    ds[1]!.resolve(2)
    await p2
    expect(order).toEqual([1, 2, 3])

    ds[2]!.resolve(3)
    await p3
    root.dispose()
  })

  test('serial dispose rejects queued runs', async () => {
    const d = deferred<number>()
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async () => d.promise,
        concurrency: 'serial',
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const p1 = root.save.run(undefined).catch((e) => e)
    const p2 = root.save.run(undefined).catch((e) => e)
    root.dispose()
    d.resolve(1) // unblock the in-flight one
    void p1 // we don't assert here; whether it resolves or rejects depends on exact ordering
    const e2 = await p2
    expect(isAbortError(e2)).toBe(true)
  })
})

describe('ctx.mutation — optimistic + rollback (§6.3, §6.4)', () => {
  test('onMutate captures snapshot; rollback restores on error', async () => {
    const q = defineQuery({
      key: () => ['n'],
      fetcher: async () => 0,
    })
    const def = defineController((ctx) => {
      const x = ctx.use(q)
      const save = ctx.mutation({
        mutate: async () => {
          throw new Error('server says no')
        },
        onMutate: () => q.setData(() => 99),
        onError: (_e, _v, snap) => snap?.rollback(),
      })
      return { x, save }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.x.data.value).toBe(0)

    await expect(root.save.run(undefined)).rejects.toThrow('server says no')
    expect(root.x.data.value).toBe(0)
    root.dispose()
  })

  test('stacked optimistic updates: later mutation rollback lands on earlier intermediate state', async () => {
    const q = defineQuery({
      key: () => ['n'],
      fetcher: async () => 0,
    })
    const dA = deferred<number>()
    const dB = deferred<number>()
    let aSnap: { rollback: () => void } | undefined
    let bSnap: { rollback: () => void } | undefined

    const def = defineController((ctx) => {
      const x = ctx.use(q)
      const a = ctx.mutation({
        mutate: async () => dA.promise,
        onMutate: () => {
          aSnap = q.setData((p) => (p ?? 0) + 1)
          return aSnap
        },
        onError: (_e, _v, snap) => snap?.rollback(),
      })
      const b = ctx.mutation({
        mutate: async () => dB.promise,
        onMutate: () => {
          bSnap = q.setData((p) => (p ?? 0) + 10)
          return bSnap
        },
        onError: (_e, _v, snap) => snap?.rollback(),
      })
      return { x, a, b }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.x.data.value).toBe(0)

    const pA = root.a.run(undefined).catch(() => {})
    const pB = root.b.run(undefined).catch(() => {})
    expect(root.x.data.value).toBe(11)

    // B fails first — should land on the post-A intermediate state.
    dB.reject(new Error('b'))
    await pB
    expect(root.x.data.value).toBe(1)

    // A then fails — restores to original.
    dA.reject(new Error('a'))
    await pA
    expect(root.x.data.value).toBe(0)
    root.dispose()
  })
})

describe('ctx.mutation — retry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('retry: 2 → 3 attempts; final error reaches caller', async () => {
    let attempts = 0
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async () => {
          attempts++
          throw new Error(`fail-${attempts}`)
        },
        retry: 2,
        retryDelay: 10,
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const p = root.save.run(undefined).catch((e) => e as Error)
    // initial attempt (0ms) + 2 retries (10ms each)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    const err = await p
    expect(attempts).toBe(3)
    expect(err.message).toBe('fail-3')
    root.dispose()
  })
})
