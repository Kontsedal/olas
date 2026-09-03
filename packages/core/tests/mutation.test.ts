import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import { MutationDisposedError } from '../src/query/mutation'
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

// T4.2 — `Mutation.status` signal. `isSuccess`/`isIdle`/`isError` derive from it
// in React, so a `void` mutation (data always undefined) still reports success.
describe('ctx.mutation — status signal (T4.2)', () => {
  test('parallel: idle → pending → success', async () => {
    const d = deferred<string>()
    const def = defineController((ctx) => ({ m: ctx.mutation({ mutate: async () => d.promise }) }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.m.status.value).toBe('idle')
    const p = root.m.run()
    expect(root.m.status.value).toBe('pending')
    d.resolve('ok')
    await p
    expect(root.m.status.value).toBe('success')
    root.dispose()
  })

  test('a void mutation reports status success (data stays undefined)', async () => {
    const def = defineController((ctx) => ({ m: ctx.mutation({ mutate: async () => {} }) }))
    const root = createRoot(def, { deps: emptyDeps })
    await root.m.run()
    expect(root.m.status.value).toBe('success')
    expect(root.m.data.value).toBeUndefined()
    root.dispose()
  })

  test('a throwing mutation → status error', async () => {
    const def = defineController((ctx) => ({
      m: ctx.mutation({
        mutate: async () => {
          throw new Error('boom')
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await root.m.run().catch(() => {})
    expect(root.m.status.value).toBe('error')
    root.dispose()
  })

  test('latest-wins: a superseded run does not flip status to error', async () => {
    const dB = deferred<string>()
    const def = defineController((ctx) => ({
      m: ctx.mutation({
        mutate: async (v: 'a' | 'b') => (v === 'b' ? dB.promise : new Promise<string>(() => {})), // 'a' hangs until aborted
        concurrency: 'latest-wins',
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const pA = root.m.run('a').catch(() => {}) // superseded by B
    const pB = root.m.run('b')
    expect(root.m.status.value).toBe('pending')
    dB.resolve('B')
    await pB
    await pA
    // B's success owns the terminal status; A's supersede must not overwrite it.
    expect(root.m.status.value).toBe('success')
    root.dispose()
  })

  test('reset → status idle', async () => {
    const def = defineController((ctx) => ({ m: ctx.mutation({ mutate: async () => 'x' }) }))
    const root = createRoot(def, { deps: emptyDeps })
    await root.m.run()
    expect(root.m.status.value).toBe('success')
    root.m.reset()
    expect(root.m.status.value).toBe('idle')
    root.dispose()
  })
})

describe('dispose — what a torn-down mutation does with a write', () => {
  test('run() after dispose rejects with MutationDisposedError, and mutate never runs', async () => {
    let mutateCalls = 0
    const def = defineController(
      (ctx) => ({
        drop: ctx.mutation({
          name: 'dropDatabase',
          mutate: async () => {
            mutateCalls += 1
            return 'dropped'
          },
        }),
      }),
      { name: 'sidebar' },
    )
    const root = createRoot(def, { deps: emptyDeps })
    root.dispose()

    const err = await root.drop.run().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MutationDisposedError)
    expect(mutateCalls).toBe(0)
    // The whole point of the type: a caller filtering cancellations must NOT
    // swallow this one — the write it asked for silently did not happen.
    expect(isAbortError(err)).toBe(false)
    expect((err as MutationDisposedError).mutationName).toBe('dropDatabase')
    expect((err as MutationDisposedError).controllerPath).toEqual(['root'])
  })

  test('a queued serial run rejected by the same dispose IS an AbortError', async () => {
    // The two are different events and must stay distinguishable: this run was
    // accepted and then cancelled; the one above was never accepted at all.
    const d = deferred<number>()
    const def = defineController((ctx) => ({
      m: ctx.mutation({ concurrency: 'serial' as const, mutate: async () => d.promise }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const first = root.m.run()
    const queued = root.m.run()
    first.catch(() => {})
    const settled = queued.catch((e: unknown) => e)
    root.dispose()

    const err = await settled
    expect(isAbortError(err)).toBe(true)
    expect(err).not.toBeInstanceOf(MutationDisposedError)
  })

  test('a run that COMPLETED before dispose finalizes its snapshot instead of rolling it back', async () => {
    // The write reached the server. Rolling back would put a value we know to
    // be stale into a cache that outlives the mutation, and the `onSuccess`
    // that would normally invalidate is skipped on this path — so nothing
    // would ever repair it.
    const d = deferred<string>()
    const q = defineQuery({ key: () => ['doc'] as const, fetcher: async () => 'server-value' })
    let onSuccessCalls = 0
    const def = defineController((ctx) => ({
      read: ctx.use(q),
      save: ctx.mutation({
        // Deliberately NOT `async`: an async wrapper adds a microtask hop and
        // the window below is measured in hops.
        mutate: () => d.promise,
        onMutate: () => q.setData(() => 'written-value'),
        onSuccess: () => {
          onSuccessCalls += 1
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await root.read.promise()
    const settled = root.save.run().catch((e: unknown) => e)
    expect(root.read.data.value).toBe('written-value')

    d.resolve('accepted') // the server takes the write…
    // …and the screen closes in the one-microtask window after `raceAbort`
    // resolved but before `executeRun`'s continuation ran. Fewer ticks and the
    // abort listener wins the race instead (that is the in-flight case, covered
    // below); more and the run has already completed as a plain success. The
    // two assertions below pin the window: an ABORTED outcome whose snapshot
    // was nonetheless committed.
    await Promise.resolve()
    await Promise.resolve()
    expect(root.save.isPending.peek()).toBe(true) // the continuation has not run yet
    root.save.dispose()

    const err = await settled
    // The caller still walked away, so it still hears "aborted"…
    expect(isAbortError(err)).toBe(true)
    // …but the cache now agrees with the server rather than contradicting it.
    expect(root.read.data.peek()).toBe('written-value')
    // Still not a success for the mutation's own signals: nobody is reading them.
    expect(onSuccessCalls).toBe(0)
    root.dispose()
  })

  test('a run still IN FLIGHT at dispose is rolled back, as before', async () => {
    // The guard for the case above: only a COMPLETED run finalizes. One that
    // never resolved has no server truth to commit to.
    const d = deferred<string>()
    const q = defineQuery({ key: () => ['doc2'] as const, fetcher: async () => 'server-value' })
    const def = defineController((ctx) => ({
      read: ctx.use(q),
      save: ctx.mutation({
        mutate: async () => d.promise,
        onMutate: () => q.setData(() => 'written-value'),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await root.read.promise()
    const settled = root.save.run().catch((e: unknown) => e)
    expect(root.read.data.value).toBe('written-value')

    root.save.dispose() // aborted while genuinely in flight
    const err = await settled
    expect(isAbortError(err)).toBe(true)
    expect(root.read.data.peek()).toBe('server-value')
    d.resolve('too late')
    root.dispose()
  })
})

describe('detached mutations (§6.5)', () => {
  test('dispose does not abort an in-flight detached run; it resolves and settles', async () => {
    const d = deferred<string>()
    const q = defineQuery({ key: () => ['lic'] as const, fetcher: async () => 'free' })
    const seen: string[] = []
    const def = defineController((ctx) => ({
      read: ctx.use(q),
      activate: ctx.mutation({
        detached: true,
        mutate: async () => d.promise,
        onMutate: () => q.setData(() => 'pro-optimistic'),
        onSuccess: (r: string) => seen.push(`success:${r}`),
        onSettled: (_r, err) => seen.push(`settled:${err === undefined ? 'ok' : 'err'}`),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await root.read.promise()
    const run = root.activate.run()

    root.activate.dispose() // the modal closes mid-activation
    d.resolve('pro')

    await expect(run).resolves.toBe('pro')
    expect(seen).toEqual(['success:pro', 'settled:ok'])
    expect(root.read.data.peek()).toBe('pro-optimistic')
    root.dispose()
  })

  test('run() still works after dispose — the confirm answered too late', async () => {
    // The shape this option exists for: a destructive action whose confirm the
    // user answers after the panel that owns the mutation is already gone.
    let dropped: string | undefined
    const def = defineController((ctx) => ({
      drop: ctx.mutation({
        detached: true,
        mutate: async (name: string) => {
          dropped = name
          return 'ok'
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.drop.dispose()

    await expect(root.drop.run('analytics')).resolves.toBe('ok')
    expect(dropped).toBe('analytics')
    root.dispose()
  })

  test('a detached serial queue drains after dispose instead of rejecting', async () => {
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()]
    let started = 0
    const def = defineController((ctx) => ({
      m: ctx.mutation({
        detached: true,
        concurrency: 'serial' as const,
        mutate: async () => {
          const gate = gates[started]
          started += 1
          return (await gate?.promise) ?? -1
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const runs = [root.m.run(), root.m.run(), root.m.run()]

    root.m.dispose()
    gates[0]?.resolve(1)
    gates[1]?.resolve(2)
    gates[2]?.resolve(3)

    await expect(Promise.all(runs)).resolves.toEqual([1, 2, 3])
    root.dispose()
  })

  test('reset() still cancels a detached run — dispose is not the app saying "drop it"', async () => {
    const d = deferred<string>()
    const def = defineController((ctx) => ({
      m: ctx.mutation({ detached: true, mutate: async () => d.promise }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const settled = root.m.run().catch((e: unknown) => e)
    root.m.reset()
    d.resolve('late')

    expect(isAbortError(await settled)).toBe(true)
    root.dispose()
  })

  test('reset() keeps working after a detached mutation is disposed', async () => {
    // Its runs outlive the controller, so reset() is the only stop button left.
    const d = deferred<string>()
    const def = defineController((ctx) => ({
      m: ctx.mutation({ detached: true, mutate: async () => d.promise }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const settled = root.m.run().catch((e: unknown) => e)
    root.m.dispose()
    root.m.reset()
    d.resolve('late')

    expect(isAbortError(await settled)).toBe(true)
    root.dispose()
  })

  test('latest-wins still supersedes a detached run', async () => {
    const dA = deferred<string>()
    const dB = deferred<string>()
    let call = 0
    const def = defineController((ctx) => ({
      m: ctx.mutation({
        detached: true,
        concurrency: 'latest-wins' as const,
        mutate: async () => {
          call += 1
          return call === 1 ? dA.promise : dB.promise
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const a = root.m.run().catch((e: unknown) => e)
    const b = root.m.run()
    dA.resolve('A')
    dB.resolve('B')

    expect(isAbortError(await a)).toBe(true)
    await expect(b).resolves.toBe('B')
    root.dispose()
  })

  test('the whole controller disposing leaves a detached run alone', async () => {
    // Not just `mutation.dispose()` — the path a real unmount takes.
    const d = deferred<string>()
    let settledWith: string | undefined
    const def = defineController((ctx) => ({
      m: ctx.mutation({
        detached: true,
        mutate: async () => d.promise,
        onSettled: (r) => {
          settledWith = r
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const run = root.m.run()
    root.dispose()
    d.resolve('landed')

    await expect(run).resolves.toBe('landed')
    expect(settledWith).toBe('landed')
  })
})
