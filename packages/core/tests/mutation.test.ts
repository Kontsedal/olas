import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import type { Snapshot } from '../src/query/types'
import { isAbortError } from '../src/utils'

const emptyDeps = {}

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
    await expect(root.save.run()).rejects.toThrow('save failed')
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
    const promise = root.save.run().catch((e) => e)
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
    const p1 = root.save.run()
    const p2 = root.save.run()
    const p3 = root.save.run()
    expect(root.save.isPending.value).toBe(true)

    ds[1]!.resolve('b')
    // Wait for the resolved mutation's result to land into `data`. Other
    // mutations are still in flight so `isPending` should stay true.
    await vi.waitFor(() => expect(root.save.data.value).toBe('b'))
    expect(root.save.isPending.value).toBe(true)

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
    const p1 = root.save.run().catch((e) => e)
    const p2 = root.save.run()

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
    // Wait for the initial query fetch to land before kicking off mutations
    // that touch the cache key.
    await vi.waitFor(() => expect(root.x.data.value).toBe(1))
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
    const p1 = root.save.run().catch((e) => e)
    const p2 = root.save.run().catch((e) => e)
    root.dispose()
    d.resolve(1) // unblock the in-flight one
    void p1 // we don't assert here; whether it resolves or rejects depends on exact ordering
    const e2 = await p2
    expect(isAbortError(e2)).toBe(true)
  })
})

describe('ctx.mutation — optimistic + rollback (§6.3, §6.4)', () => {
  test('snapshot returned from onMutate auto-rolls back on error without an explicit onError', async () => {
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
        // NO onError — the default behavior should still restore the cache.
      })
      return { x, save }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.x.data.value).toBe(0))

    await expect(root.save.run()).rejects.toThrow('server says no')
    expect(root.x.data.value).toBe(0)
    root.dispose()
  })

  test('onError calling snapshot.rollback() is idempotent with the auto-rollback', async () => {
    const q = defineQuery({
      key: () => ['n'],
      fetcher: async () => 0,
    })
    let rollbackCalls = 0
    const def = defineController((ctx) => {
      const x = ctx.use(q)
      const save = ctx.mutation({
        mutate: async () => {
          throw new Error('boom')
        },
        onMutate: () => {
          const snap = q.setData(() => 99)
          return {
            rollback: () => {
              rollbackCalls++
              snap.rollback()
            },
            finalize: () => snap.finalize(),
          }
        },
        onError: (_e, _v, snap) => snap?.rollback(),
      })
      return { x, save }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.x.data.value).toBe(0))

    await expect(root.save.run()).rejects.toThrow('boom')
    expect(root.x.data.value).toBe(0)
    // Both the user's onError-call AND the implicit auto-call would have
    // tried to run rollback; the wrapped snapshot dedupes to exactly one.
    expect(rollbackCalls).toBe(1)
    root.dispose()
  })

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
    await vi.waitFor(() => expect(root.x.data.value).toBe(0))

    await expect(root.save.run()).rejects.toThrow('server says no')
    expect(root.x.data.value).toBe(0)
    root.dispose()
  })

  test('hasPendingMutations clears after successful optimistic mutation', async () => {
    // Regression: setData() set the pending flag and stored a snapshot, but
    // mutation success never finalized it. Only rollback cleared it. So an
    // optimistic+successful write left `hasPendingMutations` stuck true.
    const q = defineQuery({
      key: () => ['n'],
      fetcher: async () => 0,
    })
    const def = defineController((ctx) => {
      const x = ctx.use(q)
      const save = ctx.mutation({
        mutate: async () => 'ok',
        onMutate: () => q.setData(() => 99),
      })
      return { x, save }
    })
    const root = createRoot(def, { deps: emptyDeps })
    // Wait for initial fetch to settle. hasPendingMutations is the negative
    // assertion under test post-mutation, so use data as the wait condition.
    await vi.waitFor(() => expect(root.x.data.value).toBe(0))
    expect(root.x.hasPendingMutations.value).toBe(false)

    await root.save.run()
    expect(root.x.data.value).toBe(99)
    expect(root.x.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('stacked optimistic updates: later mutation rollback lands on earlier intermediate state', async () => {
    const q = defineQuery({
      key: () => ['n'],
      fetcher: async () => 0,
    })
    const dA = deferred<number>()
    const dB = deferred<number>()
    let aSnap: Snapshot | undefined
    let bSnap: Snapshot | undefined

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
    await vi.waitFor(() => expect(root.x.data.value).toBe(0))

    const pA = root.a.run().catch(() => {})
    const pB = root.b.run().catch(() => {})
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
    const p = root.save.run().catch((e) => e as Error)
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
