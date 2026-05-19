/**
 * Regression tests covering the bugs / drifts fixed in the deep-assessment
 * pass — see `ASSESSMENT.md` at the repo root. Each test pins one specific
 * behavior so future refactors that re-introduce the original bug fail loudly.
 */
import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { Entry } from '../src/query/entry'

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

// ---------------------------------------------------------------------------
// B1 — InfiniteEntry stuck `isFetchingNextPage` / `isFetchingPreviousPage`.
// ---------------------------------------------------------------------------
describe('regression: InfiniteEntry direction flags reset on supersede', () => {
  // Build a fetcher that honors AbortSignal — otherwise a supersede can't
  // actually unstick the pending promise (the user's fetcher would still
  // hang on its own deferred).
  type Page = { items: string[]; next: number | null; prev: number | null }
  const abortingFetcher = (
    by: (pageParam: number) => Promise<Page> | Page,
  ): ((ctx: { pageParam: number; signal: AbortSignal }) => Promise<Page>) => {
    return ({ pageParam, signal }) =>
      new Promise<Page>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
        Promise.resolve(by(pageParam)).then(resolve, reject)
      })
  }

  test('fetchNextPage superseded by invalidate clears isFetchingNextPage', async () => {
    // Init with a no-op so TS CFA doesn't narrow to `null`.
    let resolveSecond: (p: Page) => void = () => {}
    const q = defineInfiniteQuery<[], number, Page>({
      key: () => [],
      fetcher: abortingFetcher((pageParam) => {
        if (pageParam === 0) return { items: ['a'], next: 1, prev: null }
        // page 1 (fetchNextPage) — hold indefinitely until we resolve.
        return new Promise<Page>((res) => {
          resolveSecond = res
        })
      }),
      initialPageParam: 0,
      getNextPageParam: (page) => page.next,
    })

    const def = defineController((ctx) => ({ chat: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.chat.pages.value.length).toBe(1)

    const nextPromise = root.chat.fetchNextPage()
    await flush()
    expect(root.chat.isFetchingNextPage.value).toBe(true)

    // Supersede — invalidate aborts the pending fetcher's signal.
    q.invalidate()
    await nextPromise.catch(() => {})
    await flush()

    expect(root.chat.isFetchingNextPage.value).toBe(false)
    // Silence the hanging promise (it would otherwise stay alive in the
    // event loop tail until vitest tears down).
    resolveSecond({ items: [], next: null, prev: null })
    root.dispose()
  })

  test('fetchPreviousPage superseded clears isFetchingPreviousPage', async () => {
    let resolvePrev: (p: Page) => void = () => {}
    const q = defineInfiniteQuery<[], number, Page>({
      key: () => [],
      fetcher: abortingFetcher((pageParam) => {
        if (pageParam === 1) return { items: ['b'], next: 2, prev: 0 }
        return new Promise<Page>((res) => {
          resolvePrev = res
        })
      }),
      initialPageParam: 1,
      getNextPageParam: (page) => page.next,
      getPreviousPageParam: (page) => page.prev,
    })
    const def = defineController((ctx) => ({ chat: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    const prevPromise = root.chat.fetchPreviousPage()
    await flush()
    expect(root.chat.isFetchingPreviousPage.value).toBe(true)
    q.invalidate()
    await prevPromise.catch(() => {})
    await flush()
    expect(root.chat.isFetchingPreviousPage.value).toBe(false)
    resolvePrev({ items: [], next: null, prev: null })
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// B2 — Mutation.reset() leaks queued serial runs.
// ---------------------------------------------------------------------------
describe('regression: Mutation.reset rejects queued serial runs', () => {
  test('reset() during a serial mutation rejects queued promises', async () => {
    const d1 = deferred<number>()
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        concurrency: 'serial' as const,
        mutate: async (vars: number) => {
          if (vars === 1) return d1.promise
          return vars
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    // Start one (will hang on d1) and queue two more.
    const p1 = root.save.run(1)
    const p2 = root.save.run(2)
    const p3 = root.save.run(3)
    await flush()
    // Reset — queued p2/p3 must reject; p1 must abort.
    root.save.reset()
    await expect(p2).rejects.toThrow()
    await expect(p3).rejects.toThrow()
    await expect(p1).rejects.toThrow()
    expect(root.save.isPending.value).toBe(false)
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// B3 — Entry.firstValue() never settles after dispose.
// ---------------------------------------------------------------------------
describe('regression: Entry.firstValue rejects on dispose', () => {
  test('disposing an entry mid-fetch rejects pending firstValue() callers', async () => {
    const blocking = deferred<number>()
    const entry = new Entry<number>({
      fetcher: () => (signal) =>
        new Promise<number>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          blocking.promise.then(resolve, reject)
        }),
    })
    entry.startFetch().catch(() => {}) // ignore the abort-rejection
    const fv = entry.firstValue()
    // dispose before the fetch can settle.
    entry.dispose()
    await expect(fv).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// B4 — Hydrated entries lie about `isStale` when staleTime > 0 and data is old.
// ---------------------------------------------------------------------------
describe('regression: hydrated isStale reflects actual age', () => {
  test('hydrated entry older than staleTime reads isStale=true on construction', () => {
    const STALE_TIME = 60_000
    const HOUR_AGO = Date.now() - 60 * 60 * 1000
    const entry = new Entry<number>({
      fetcher: () => () => Promise.resolve(0),
      staleTime: STALE_TIME,
      initialData: 7,
      initialUpdatedAt: HOUR_AGO, // way older than staleTime
    })
    expect(entry.data.peek()).toBe(7)
    expect(entry.isStale.peek()).toBe(true)
    entry.dispose()
  })

  test('hydrated entry within staleTime reads isStale=false', () => {
    const STALE_TIME = 60_000
    const RECENT = Date.now() - 1_000
    const entry = new Entry<number>({
      fetcher: () => () => Promise.resolve(0),
      staleTime: STALE_TIME,
      initialData: 7,
      initialUpdatedAt: RECENT,
    })
    expect(entry.isStale.peek()).toBe(false)
    entry.dispose()
  })
})

// ---------------------------------------------------------------------------
// B5 — invalidate-supersede no longer spams console.error / onError.
// ---------------------------------------------------------------------------
describe('regression: invalidate AbortError does not reach onError', () => {
  test('back-to-back q.invalidate() does not dispatch a cache error', async () => {
    const onError = vi.fn()
    const fetches: Array<{
      resolve: (n: number) => void
      reject: (e: unknown) => void
      signal: AbortSignal
    }> = []
    const q = defineQuery({
      key: () => ['k'],
      fetcher: async ({ signal }) =>
        new Promise<number>((resolve, reject) => {
          fetches.push({ resolve, reject, signal })
        }),
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps, onError })
    await flush()
    expect(fetches.length).toBe(1)
    // Resolve initial so a subsequent invalidate has something to supersede.
    fetches[0]!.resolve(1)
    await flush()
    q.invalidate()
    q.invalidate()
    q.invalidate()
    await flush()
    // None of the supersedes should reach onError as cache kind.
    const cacheErrs = onError.mock.calls.filter((c) => (c[1] as { kind: string }).kind === 'cache')
    expect(cacheErrs.length).toBe(0)
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// B6 — Synchronous validator throws route through onError + appear in errors.
// ---------------------------------------------------------------------------
describe('regression: sync validator throws are surfaced', () => {
  test('throwing validator on a field marks invalid AND calls root.onError', async () => {
    const onError = vi.fn()
    const def = defineController((ctx) => ({
      name: ctx.field<string>('', [
        () => {
          throw new Error('validator-boom')
        },
      ]),
    }))
    const root = createRoot(def, { deps: emptyDeps, onError })
    await flush()
    expect(root.name.isValid.value).toBe(false)
    expect(root.name.errors.value).toContain('validator-boom')
    const eff = onError.mock.calls.find((c) => (c[1] as { kind: string }).kind === 'effect')
    expect(eff).toBeTruthy()
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// B7 — Form.applyPartial tolerates undefined nested values.
// ---------------------------------------------------------------------------
describe('regression: Form.set({nestedForm: undefined}) does not throw', () => {
  test('undefined nested form value is a no-op', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('init'),
        nested: ctx.form({ inner: ctx.field<string>('x') }),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    // Should NOT throw.
    expect(() =>
      root.form.set({ name: 'new', nested: undefined as unknown as undefined }),
    ).not.toThrow()
    expect(root.form.fields.name.value).toBe('new')
    expect(root.form.fields.nested.fields.inner.value).toBe('x')
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// B9 — ctx.effect called during 'suspended' state.
// ---------------------------------------------------------------------------
describe('regression: ctx.effect during suspend does not double-activate', () => {
  test('an effect added in onSuspend activates exactly once on resume', () => {
    let activations = 0
    const def = defineController((ctx) => {
      ctx.onSuspend(() => {
        // Adding an effect during suspend should not activate it twice on resume.
        ctx.effect(() => {
          activations += 1
        })
      })
      return {}
    })
    const root = createRoot(def, { deps: emptyDeps })
    root.suspend()
    expect(activations).toBe(0)
    root.resume()
    expect(activations).toBe(1)
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// D2 — invalidateAll refetches every entry of the query.
// ---------------------------------------------------------------------------
describe('regression: invalidateAll re-runs every bound entry', () => {
  test('invalidateAll causes both keys to refetch', async () => {
    const counts = { a: 0, b: 0 }
    const q = defineQuery({
      key: (id: string) => ['k', id],
      fetcher: async (_ctx, id: string) => {
        counts[id as 'a' | 'b'] += 1
        return id.toUpperCase()
      },
    })
    const id = { current: 'a' as 'a' | 'b' }
    const def = defineController((ctx) => ({
      sub: ctx.use(q, () => [id.current] as const),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    // Mount a second subscription via root re-creation to build a second entry.
    const def2 = defineController((ctx) => ({ sub: ctx.use(q, () => ['b'] as const) }))
    const root2 = createRoot(def2, { deps: emptyDeps })
    await flush()
    expect(counts.a).toBe(1)
    expect(counts.b).toBe(1)
    q.invalidateAll()
    await flush()
    expect(counts.a).toBe(2)
    expect(counts.b).toBe(2)
    root.dispose()
    root2.dispose()
  })
})

// ---------------------------------------------------------------------------
// D3 — suspend pauses refetchInterval (spec §4.1).
// ---------------------------------------------------------------------------
describe('regression: suspend pauses refetchInterval', () => {
  test('refetchInterval timer does not fire while controller is suspended', async () => {
    vi.useFakeTimers()
    let calls = 0
    const q = defineQuery({
      key: () => ['k'],
      fetcher: async () => {
        calls += 1
        return calls
      },
      refetchInterval: 100,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    // Wait initial fetch.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    // Suspend — timer should stop.
    root.suspend()
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toBe(1)
    // Resume — refetch on resume (entry is stale post-time-advance).
    root.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBeGreaterThanOrEqual(2)
    root.dispose()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// D4 — reactive Form initial: re-seats on tracked-signal change while clean.
// ---------------------------------------------------------------------------
describe('regression: reactive Form initial re-seats while clean, not while dirty', () => {
  test('clean form re-seats when tracked signal changes', async () => {
    const { signal } = await import('../src/signals')
    const seed = signal('first')
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('') }, { initial: () => ({ name: seed.value }) }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.fields.name.value).toBe('first')
    // Change tracked value.
    seed.set('second')
    // The effect runs synchronously on signal write.
    expect(root.form.fields.name.value).toBe('second')
    expect(root.form.isDirty.value).toBe(false)
    root.dispose()
  })

  test('dirty form does NOT re-seat on tracked-signal change (default when-clean)', async () => {
    const { signal } = await import('../src/signals')
    const seed = signal('first')
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('') }, { initial: () => ({ name: seed.value }) }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.fields.name.set('user-typed')
    expect(root.form.isDirty.value).toBe(true)
    seed.set('second')
    // Dirty → does not re-seat.
    expect(root.form.fields.name.value).toBe('user-typed')
    root.dispose()
  })

  test('resetOnInitialChange: always re-seats even when dirty', async () => {
    const { signal } = await import('../src/signals')
    const seed = signal('first')
    const def = defineController((ctx) => ({
      form: ctx.form(
        { name: ctx.field<string>('') },
        { initial: () => ({ name: seed.value }), resetOnInitialChange: 'always' },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.fields.name.set('user-typed')
    seed.set('second')
    expect(root.form.fields.name.value).toBe('second')
    root.dispose()
  })

  test('resetOnInitialChange: never keeps initial constant', async () => {
    const { signal } = await import('../src/signals')
    const seed = signal('first')
    const def = defineController((ctx) => ({
      form: ctx.form(
        { name: ctx.field<string>('') },
        { initial: () => ({ name: seed.value }), resetOnInitialChange: 'never' },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.fields.name.value).toBe('first')
    seed.set('second')
    expect(root.form.fields.name.value).toBe('first')
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// D6 — Form.validate() re-triggers top-level validators.
// ---------------------------------------------------------------------------
describe('regression: Form.validate re-runs top-level validators', () => {
  test('top-level validator re-runs against the current value', async () => {
    let lastSeen = ''
    const def = defineController((ctx) => ({
      form: ctx.form(
        { name: ctx.field<string>('') },
        {
          validators: [
            (value) => {
              lastSeen = value.name
              return null
            },
          ],
        },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(lastSeen).toBe('')
    root.form.fields.name.set('A')
    await flush()
    expect(lastSeen).toBe('A')
    // Now: clear lastSeen, set silently via direct signal-side; validate() should re-run.
    lastSeen = '__not-run__'
    await root.form.validate()
    expect(lastSeen).toBe('A')
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// debouncedValidator — async-validator AbortSignal handling.
// ---------------------------------------------------------------------------
describe('debouncedValidator', () => {
  test('only the most recent debounce call invokes the underlying fn', async () => {
    vi.useFakeTimers()
    const { debouncedValidator } = await import('../src/forms/field')
    let calls = 0
    const validator = debouncedValidator<string>(async (value) => {
      calls += 1
      return value.length < 3 ? 'too short' : null
    }, 50)
    const def = defineController((ctx) => ({
      name: ctx.field<string>('', [validator]),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    root.name.set('a')
    root.name.set('ab')
    root.name.set('abc')
    // No call yet — debounce.
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(60)
    // Only the latest survives.
    expect(calls).toBe(1)
    expect(root.name.errors.value).toEqual([])
    root.dispose()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Gap — defineQuery's `isStale` honors the timer (parity with ctx.cache).
// ---------------------------------------------------------------------------
describe('gap: defineQuery isStale timer', () => {
  test('isStale flips from false → true after staleTime ms', async () => {
    vi.useFakeTimers()
    const q = defineQuery({
      key: () => ['k'],
      fetcher: async () => 1,
      staleTime: 1_000,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    // Just-fetched data is fresh.
    expect(root.x.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(root.x.isStale.value).toBe(true)
    root.dispose()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Gap — two concurrent fetches on the same key, latest-wins (Entry race).
// ---------------------------------------------------------------------------
describe('gap: query latest-wins under concurrent fetches', () => {
  test('a second startFetch supersedes the first; only the latter result lands', async () => {
    const sequence: { resolve: (n: number) => void; signal: AbortSignal }[] = []
    const q = defineQuery({
      key: () => ['k'],
      fetcher: async ({ signal }) => {
        return new Promise<number>((resolve, reject) => {
          sequence.push({ resolve, signal })
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      },
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(sequence.length).toBe(1)
    // Trigger a second fetch via refetch — supersedes the first.
    const refetchPromise = root.x.refetch()
    await flush()
    expect(sequence.length).toBe(2)
    // First's signal must have been aborted.
    expect(sequence[0]!.signal.aborted).toBe(true)
    // Resolve the second; it lands as data.
    sequence[1]!.resolve(99)
    await refetchPromise.catch(() => {})
    await flush()
    expect(root.x.data.value).toBe(99)
    // Resolve the first (already superseded) — should NOT clobber.
    sequence[0]!.resolve(1)
    await flush()
    expect(root.x.data.value).toBe(99)
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// Gap — in-flight mutation at dehydrate time.
// ---------------------------------------------------------------------------
describe('gap: dehydrate while a mutation is in flight', () => {
  test('waitForIdle blocks until in-flight mutation settles; dehydrate then includes the optimistic state', async () => {
    const q = defineQuery({
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string) => ({ id, name: 'initial' }),
    })
    const inFlight = deferred<{ id: string; name: string }>()

    const def = defineController((ctx) => {
      const user = ctx.use(q, () => ['1'])
      const save = ctx.mutation({
        mutate: () => inFlight.promise,
        onMutate: () =>
          q.setData('1', (prev) => ({ ...(prev ?? { id: '1' }), name: 'optimistic' })),
      })
      return { user, save }
    })
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.user.data.value).toEqual({ id: '1', name: 'initial' })

    // Kick off the mutation; optimistic state lands immediately.
    const runP = root.save.run()
    await flush()
    expect(root.user.data.value).toEqual({ id: '1', name: 'optimistic' })

    // waitForIdle MUST wait for the inflight mutation. Race it against a
    // short timer; expect the timer to win until we resolve the mutation.
    const idlePromise = root.waitForIdle()
    let idleSettled = false
    idlePromise.then(() => {
      idleSettled = true
    })
    await flush()
    expect(idleSettled).toBe(false)

    // Resolve the mutation; waitForIdle releases.
    inFlight.resolve({ id: '1', name: 'committed' })
    await runP
    await idlePromise
    expect(idleSettled).toBe(true)

    // Dehydrate snapshot reflects the committed (finalized) state.
    const dehydrated = root.dehydrate()
    const entry = dehydrated.entries.find((e) => Array.isArray(e.key) && e.key[1] === '1')
    expect(entry?.data).toEqual({ id: '1', name: 'optimistic' })
    // (Optimistic value survived to dehydrate because `onMutate` wrote it
    // through setData and `onSuccess` didn't overwrite — mutate's `mutate`
    // resolves into save.data, not into the query.)

    root.dispose()
  })
})
