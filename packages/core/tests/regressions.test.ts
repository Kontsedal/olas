/**
 * Regression tests covering the bugs / drifts fixed in the deep-assessment
 * pass — see `ASSESSMENT.md` at the repo root. Each test pins one specific
 * behavior so future refactors that re-introduce the original bug fail loudly.
 */
import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { Entry } from '../src/query/entry'
import { InfiniteEntry } from '../src/query/infinite'
import { signal } from '../src/signals'
import type { QueryClientPlugin, QueryClientPluginApi } from '../src/query/plugin'

const emptyDeps = {}
/**
 * Generic microtask drain — kept for tests asserting "X did NOT happen
 * after a settling pause". For positive "wait until X is true" assertions,
 * use `await vi.waitFor(() => expect(...))` which polls and is resilient
 * to implementation microtask-depth changes.
 */
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
    await vi.waitFor(() => expect(root.chat.pages.value.length).toBe(1))

    const nextPromise = root.chat.fetchNextPage()
    await vi.waitFor(() => expect(root.chat.isFetchingNextPage.value).toBe(true))

    // Supersede — invalidate aborts the pending fetcher's signal.
    q.invalidate()
    await nextPromise.catch(() => {})
    await vi.waitFor(() => expect(root.chat.isFetchingNextPage.value).toBe(false))
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
    await vi.waitFor(() => expect(root.chat.pages.value.length).toBe(1))
    const prevPromise = root.chat.fetchPreviousPage()
    await vi.waitFor(() => expect(root.chat.isFetchingPreviousPage.value).toBe(true))
    q.invalidate()
    await prevPromise.catch(() => {})
    await vi.waitFor(() => expect(root.chat.isFetchingPreviousPage.value).toBe(false))
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
    // Let isPending flip + the runs settle into the serial queue.
    await vi.waitFor(() => expect(root.save.isPending.value).toBe(true))
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
    await vi.waitFor(() => expect(fetches.length).toBe(1))
    // Resolve initial so a subsequent invalidate has something to supersede.
    fetches[0]!.resolve(1)
    await vi.waitFor(() => expect(root.x.data.value).toBe(1))
    q.invalidate()
    q.invalidate()
    q.invalidate()
    // The supersedes are sync — let the rejection-handling microtasks drain.
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
    await vi.waitFor(() => expect(root.name.errors.value).toContain('validator-boom'))
    expect(root.name.isValid.value).toBe(false)
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
    await vi.waitFor(() => expect(counts.a).toBe(1))
    // Mount a second subscription via root re-creation to build a second entry.
    const def2 = defineController((ctx) => ({ sub: ctx.use(q, () => ['b'] as const) }))
    const root2 = createRoot(def2, { deps: emptyDeps })
    await vi.waitFor(() => expect(counts.b).toBe(1))
    q.invalidateAll()
    await vi.waitFor(() => {
      expect(counts.a).toBe(2)
      expect(counts.b).toBe(2)
    })
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
    await vi.waitFor(() => expect(lastSeen).toBe(''))
    root.form.fields.name.set('A')
    await vi.waitFor(() => expect(lastSeen).toBe('A'))
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

  test('rejects immediately when the validator is invoked with an already-aborted signal', async () => {
    const { debouncedValidator } = await import('../src/forms/field')
    const v = debouncedValidator<string>(async () => null, 50)
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(v('x', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('field — async validator rejection (non-abort) surfaces as an error message', () => {
  test('rejection with an Error: message lands in field.errors', async () => {
    const v = (async () => {
      throw new Error('network down')
    }) as (value: string, signal: AbortSignal) => Promise<string | null>
    const def = defineController((ctx) => ({ name: ctx.field<string>('x', [v]) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.name.errors.value).toContain('network down'))
    root.dispose()
  })

  test('rejection with a non-Error value coerces to string', async () => {
    const v = (async () => {
      throw 'plain string reason' // eslint-disable-line no-throw-literal
    }) as (value: string, signal: AbortSignal) => Promise<string | null>
    const def = defineController((ctx) => ({ name: ctx.field<string>('x', [v]) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.name.errors.value).toContain('plain string reason'))
    root.dispose()
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
    await vi.waitFor(() => expect(sequence.length).toBe(1))
    // Trigger a second fetch via refetch — supersedes the first.
    const refetchPromise = root.x.refetch()
    await vi.waitFor(() => expect(sequence.length).toBe(2))
    // First's signal must have been aborted.
    expect(sequence[0]!.signal.aborted).toBe(true)
    // Resolve the second; it lands as data.
    sequence[1]!.resolve(99)
    await refetchPromise.catch(() => {})
    await vi.waitFor(() => expect(root.x.data.value).toBe(99))
    // Resolve the first (already superseded) — should NOT clobber. Drain a
    // few microtasks to give the stale resolution a chance to leak through.
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
    await vi.waitFor(() => expect(root.user.data.value).toEqual({ id: '1', name: 'initial' }))

    // Kick off the mutation; optimistic state lands immediately.
    const runP = root.save.run()
    await vi.waitFor(() => expect(root.user.data.value).toEqual({ id: '1', name: 'optimistic' }))

    // waitForIdle MUST wait for the inflight mutation.
    const idlePromise = root.waitForIdle()
    let idleSettled = false
    idlePromise.then(() => {
      idleSettled = true
    })
    // Negative assertion ("did NOT settle yet") — drain microtasks.
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

// ---------------------------------------------------------------------------
// R-Q1.1 (T1.1) — plugin/remote setData must NOT push an optimistic snapshot.
// applyRemoteSetData / setEntryData are canonical cache writes (cross-tab
// receive, entities backprop, realtime patches). Before the fix they routed
// through the *tracked* `Entry.setData`, discarded the returned Snapshot, and
// so leaked a live record — wedging `hasPendingMutations` at `true` forever.
// ---------------------------------------------------------------------------
describe('regression: plugin/remote setData does not wedge hasPendingMutations (R-Q1.1)', () => {
  test('applyRemoteSetData leaves hasPendingMutations false', async () => {
    let api: QueryClientPluginApi | undefined
    const q = defineQuery({
      queryId: 'r-q1a-user',
      key: (id: string) => ['user', id] as const,
      fetcher: async (_ctx, id: string) => ({ id, name: 'initial' }),
    })
    const capture: QueryClientPlugin = {
      name: 'capture',
      init: (a) => {
        api = a
      },
    }
    const def = defineController((ctx) => ({ user: ctx.use(q, () => ['1'] as const) }))
    const root = createRoot(def, { deps: emptyDeps, plugins: [capture] })
    await vi.waitFor(() => expect(root.user.data.value).toEqual({ id: '1', name: 'initial' }))
    expect(root.user.hasPendingMutations.value).toBe(false)

    const [keyArgs] = api!.subscribedKeys('r-q1a-user')
    api!.applyRemoteSetData('r-q1a-user', keyArgs!, { id: '1', name: 'remote' })

    expect(root.user.data.value).toEqual({ id: '1', name: 'remote' })
    expect(root.user.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('setEntryData leaves hasPendingMutations false', async () => {
    let api: QueryClientPluginApi | undefined
    const q = defineQuery({
      queryId: 'r-q1b-user',
      key: (id: string) => ['user', id] as const,
      fetcher: async (_ctx, id: string) => ({ id, name: 'initial' }),
    })
    const capture: QueryClientPlugin = {
      name: 'capture',
      init: (a) => {
        api = a
      },
    }
    const def = defineController((ctx) => ({ user: ctx.use(q, () => ['1'] as const) }))
    const root = createRoot(def, { deps: emptyDeps, plugins: [capture] })
    await vi.waitFor(() => expect(root.user.data.value).toEqual({ id: '1', name: 'initial' }))

    const [keyArgs] = api!.subscribedKeys('r-q1b-user')
    api!.setEntryData('r-q1b-user', keyArgs!, (prev) => ({
      ...(prev as { id: string; name: string }),
      name: 'patched',
    }))

    expect(root.user.data.value).toEqual({ id: '1', name: 'patched' })
    expect(root.user.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('setEntryData on an infinite query leaves hasPendingMutations false', async () => {
    let api: QueryClientPluginApi | undefined
    type Page = { items: string[]; next: number | null }
    const q = defineInfiniteQuery<[], number, Page>({
      queryId: 'r-q1c-feed',
      key: () => [] as const,
      fetcher: async ({ pageParam }) => ({ items: [`p${pageParam}`], next: null }),
      initialPageParam: 0,
      getNextPageParam: (page) => page.next,
    })
    const capture: QueryClientPlugin = {
      name: 'capture',
      init: (a) => {
        api = a
      },
    }
    const def = defineController((ctx) => ({ feed: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps, plugins: [capture] })
    await vi.waitFor(() => expect(root.feed.pages.value.length).toBe(1))

    const [keyArgs] = api!.subscribedKeys('r-q1c-feed')
    api!.setEntryData('r-q1c-feed', keyArgs!, (prev) => {
      const pages = prev as Page[]
      return [{ items: [...pages[0]!.items, 'patched'], next: null }]
    })

    expect(root.feed.hasPendingMutations.value).toBe(false)
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-Q1.2 (T1.2) — hydration must be namespaced by query identity, not just the
// key hash. Two queries whose `key()` outputs collide would otherwise let a
// subscriber of query B silently adopt query A's dehydrated payload (wrong
// type at runtime) and — with staleTime > 0 — skip its own fetch entirely.
// ---------------------------------------------------------------------------
describe('regression: hydration does not steal data across colliding-key queries (R-Q1.2)', () => {
  test('query B with a colliding key hydrates its OWN data, not query A payload', async () => {
    const qA = defineQuery({
      key: () => ['shared', 'k'] as const,
      fetcher: async () => 'A-data',
      staleTime: 60_000,
    })
    const qB = defineQuery({
      key: () => ['shared', 'k'] as const,
      fetcher: async () => 'B-data',
      staleTime: 60_000,
    })

    // Server: only A is subscribed + fetched.
    const serverDef = defineController((ctx) => ({ a: ctx.use(qA) }))
    const server = createRoot(serverDef, { deps: emptyDeps })
    await server.waitForIdle()
    const state = server.dehydrate()
    server.dispose()

    // Client: fresh root, hydrate A's state, subscribe only B (colliding key).
    const clientDef = defineController((ctx) => ({ b: ctx.use(qB) }))
    const client = createRoot(clientDef, { deps: emptyDeps, hydrate: state })
    // B must fetch its OWN data — not adopt A's payload and skip its fetch.
    await vi.waitFor(() => expect(client.b.data.value).toBe('B-data'))
    client.dispose()
  })

  test('a query round-trips its own hydrated data without refetching (no regression)', async () => {
    let fetches = 0
    const q = defineQuery({
      key: () => ['solo'] as const,
      fetcher: async () => {
        fetches += 1
        return `v${fetches}`
      },
      staleTime: 60_000,
    })
    const serverDef = defineController((ctx) => ({ x: ctx.use(q) }))
    const server = createRoot(serverDef, { deps: emptyDeps })
    await vi.waitFor(() => expect(server.x.data.value).toBe('v1'))
    const state = server.dehydrate()
    server.dispose()

    const clientDef = defineController((ctx) => ({ x: ctx.use(q) }))
    const client = createRoot(clientDef, { deps: emptyDeps, hydrate: state })
    // Hydrated data is present immediately and fresh (staleTime 60s) → no refetch.
    expect(client.x.data.value).toBe('v1')
    await flush()
    expect(client.x.data.value).toBe('v1')
    expect(fetches).toBe(1)
    client.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-L2.1 (T2.1) — a key/enabled change while suspended must not brick the
// subscription. The binding effect used to `if (suspended) return` BEFORE
// reading any signal, so a re-run triggered by a key change during suspension
// read nothing, emptied its dependency set, and went inert — every later key
// change (after resume) was silently ignored.
// ---------------------------------------------------------------------------
describe('regression: key change while suspended survives resume (R-L2.1)', () => {
  test('regular query: a key changed after resume is honored', async () => {
    const { signal } = await import('../src/signals')
    const fetched: string[] = []
    const q = defineQuery({
      key: (id: string) => ['item', id] as const,
      fetcher: async (_ctx, id: string) => {
        fetched.push(id)
        return id.toUpperCase()
      },
    })
    const id = signal('a')
    const def = defineController((ctx) => ({ item: ctx.use(q, () => [id.value] as const) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(fetched).toContain('a'))

    root.suspend()
    id.set('b') // key change WHILE suspended — used to empty the effect's deps
    root.resume() // resume() imperatively rebinds once → 'b'
    await vi.waitFor(() => expect(fetched).toContain('b'))

    id.set('c') // key change AFTER resume — the effect must still re-run
    await vi.waitFor(() => expect(fetched).toContain('c'))
    root.dispose()
  })

  test('infinite query: a key changed after resume rebinds + fetches', async () => {
    const { signal } = await import('../src/signals')
    let fetchCount = 0
    type Page = { items: number[]; next: number | null }
    const q = defineInfiniteQuery<[string], number, Page>({
      key: (id: string) => ['feed', id] as const,
      fetcher: async ({ pageParam }) => {
        fetchCount += 1
        return { items: [pageParam], next: null }
      },
      initialPageParam: 0,
      getNextPageParam: (p) => p.next,
    })
    const id = signal('a')
    const def = defineController((ctx) => ({ feed: ctx.use(q, () => [id.value] as const) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(fetchCount).toBe(1))

    root.suspend()
    id.set('b')
    root.resume()
    await vi.waitFor(() => expect(fetchCount).toBe(2)) // resume rebinds to 'b'

    id.set('c') // post-resume change → new entry → fetch
    await vi.waitFor(() => expect(fetchCount).toBe(3))
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-L2.2 (T2.2) — an effect registered during resume() (e.g. from an onResume
// handler) is created live by ctx.effect, then the resume forward-loop reaches
// the freshly-pushed node and re-activates it — overwriting the live dispose
// ref without calling it. Result: the effect runs twice per change and one
// copy survives root.dispose(). (Requires a trailing lifecycle entry so the
// forward loop continues past the onResume entry to the new node.)
// ---------------------------------------------------------------------------
describe('regression: effect registered during resume activates exactly once (R-L2.2)', () => {
  test('onResume-registered effect runs once per change and stops on dispose', async () => {
    const { signal } = await import('../src/signals')
    const tick = signal(0)
    let runs = 0
    const def = defineController((ctx) => {
      ctx.onResume(() => {
        ctx.effect(() => {
          tick.value // track
          runs += 1
        })
      })
      // Trailing entry so the resume forward-loop continues past the onResume
      // entry and reaches the effect it just pushed — where the bug fires.
      ctx.effect(() => {})
      return {}
    })
    const root = createRoot(def, { deps: emptyDeps })
    expect(runs).toBe(0) // onResume hasn't fired yet

    root.suspend()
    root.resume() // onResume fires → ctx.effect registered + runs exactly once
    expect(runs).toBe(1)

    tick.set(1) // one dependency change → exactly one run
    expect(runs).toBe(2)

    root.dispose()
    const afterDispose = runs
    tick.set(2) // disposed → no orphaned copy still running
    expect(runs).toBe(afterDispose)
    root.dispose() // idempotent
  })
})

// ---------------------------------------------------------------------------
// R-L2.3 (T2.3) — the ctx.collection reconcile effect must not track signals
// read by user code (keyOf / item factory / child construct). Before the fix
// the whole reconcile body ran in the tracked effect scope, so an item factory
// that read one unrelated signal made every write to it re-reconcile the whole
// collection.
// ---------------------------------------------------------------------------
describe('regression: collection reconcile ignores item-factory signal reads (R-L2.3)', () => {
  test('writing an unrelated signal read by an item factory does not re-reconcile', async () => {
    const { signal } = await import('../src/signals')
    const unrelated = signal(0)
    let keyOfCalls = 0
    const item = defineController((_ctx, props: { id: string }) => {
      unrelated.value // item factory reads an UNRELATED signal
      return { id: props.id }
    })
    const source = signal<ReadonlyArray<{ id: string }>>([{ id: 'a' }, { id: 'b' }])
    const def = defineController((ctx) => ({
      c: ctx.collection({
        source,
        keyOf: (i) => {
          keyOfCalls += 1
          return i.id
        },
        controller: item,
        propsOf: (i) => ({ id: i.id }),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const keyOfAfterInit = keyOfCalls
    expect(root.c.size.value).toBe(2)

    // Write the unrelated signal the item factory read. Pre-fix the reconcile
    // effect tracked it (factory ran in the tracked scope) → a spurious
    // re-reconcile that re-invokes keyOf. Post-fix: no reconcile.
    unrelated.set(1)
    expect(keyOfCalls).toBe(keyOfAfterInit)

    // Sanity: the source signal still drives reconcile.
    source.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(root.c.size.value).toBe(3)
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-L2.4 (T2.4) — every ctx.* factory must throw when called after the owning
// controller is disposed. Before the fix only ctx.effect guarded (and it
// silently no-op'd); the rest pushed into a cleared lifecycle list — live
// children/subscriptions that never got torn down.
// ---------------------------------------------------------------------------
describe('regression: ctx.* factories throw after dispose (R-L2.4)', () => {
  test('every entry-creating ctx.* method throws after dispose', async () => {
    const { signal } = await import('../src/signals')
    let captured: any
    let capturedEmitter: any
    const childDef = defineController(() => ({}))
    const q = defineQuery({ key: () => ['k'] as const, fetcher: async () => 1 })
    const def = defineController((ctx) => {
      captured = ctx
      capturedEmitter = ctx.emitter<number>()
      return {}
    })
    const root = createRoot(def, { deps: emptyDeps })
    root.dispose()

    const throws = (fn: () => void) => expect(fn).toThrow(/disposed/)
    throws(() => captured.effect(() => {}))
    throws(() => captured.cache(async () => 1))
    throws(() => captured.use(q))
    throws(() => captured.mutation({ mutate: async () => 1 }))
    throws(() => captured.emitter())
    throws(() => captured.field(''))
    throws(() => captured.form({}))
    throws(() => captured.fieldArray(() => ({})))
    throws(() => captured.on(capturedEmitter, () => {}))
    throws(() => captured.child(childDef, {}))
    throws(() => captured.attach(childDef, {}))
    throws(() => captured.session(childDef, {}))
    throws(() =>
      captured.collection({
        source: signal([]),
        keyOf: (x: unknown) => x,
        controller: childDef,
        propsOf: () => ({}),
      }),
    )
    throws(() => captured.lazyChild(async () => childDef, {}))
    throws(() => captured.onDispose(() => {}))
    throws(() => captured.onSuspend(() => {}))
    throws(() => captured.onResume(() => {}))
    root.dispose()
  })

  test('ctx.session after dispose does not construct a child (no leak)', async () => {
    let captured: any
    let constructed = 0
    const childDef = defineController(() => {
      constructed += 1
      return {}
    })
    const def = defineController((ctx) => {
      captured = ctx
      return {}
    })
    const root = createRoot(def, { deps: emptyDeps })
    root.dispose()
    expect(constructed).toBe(0)
    expect(() => captured.session(childDef, {})).toThrow(/disposed/)
    expect(constructed).toBe(0) // the child must NOT be constructed
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-L2.5 (T2.5) — a root-controls NAME CONFLICT (api defines `dispose` etc.)
// throws inside attachRootControls, AFTER the tree is fully constructed. That
// throw was outside any try/catch, so instance.dispose() / queryClient.dispose()
// never ran — leaking effects + focus/online/plugin listeners. Mirrors the
// factory-throw teardown test in controller.test.ts.
// ---------------------------------------------------------------------------
describe('regression: root-controls conflict disposes the tree (R-L2.5)', () => {
  test('an api that defines `dispose` tears down instance + queryClient before throwing', () => {
    const pluginDispose = vi.fn()
    const onDisposeHook = vi.fn()
    const plugin = { init: vi.fn(), dispose: pluginDispose }
    const conflicting = defineController((ctx) => {
      ctx.onDispose(onDisposeHook)
      return { dispose: () => {} } // collides with the root controls
    })
    expect(() => createRoot(conflicting, { deps: emptyDeps, plugins: [plugin] })).toThrow(
      /conflicts with the root controls/,
    )
    // The fully-constructed tree must be torn down before the throw propagates.
    expect(onDisposeHook).toHaveBeenCalledTimes(1) // instance.dispose() ran
    expect(pluginDispose).toHaveBeenCalledTimes(1) // queryClient.dispose() ran
  })
})

// ---------------------------------------------------------------------------
// R-L2.6 (T2.6) — an explicitly-suspended child (attach.suspend / collection
// suspendItem) must survive a whole-tree suspend()/resume() cascade (what
// KeepAlive does). Before the fix the tree resume woke every child, so a
// virtualized list's scrolled-out rows all resumed; and attach.resume() under
// a still-suspended parent activated a child inside a frozen tree.
// ---------------------------------------------------------------------------
describe('regression: explicit suspension survives tree suspend/resume (R-L2.6)', () => {
  test('(a) collection suspendItem survives a tree cycle', async () => {
    const { signal } = await import('../src/signals')
    const item = defineController(() => ({}))
    const source = signal<ReadonlyArray<{ id: string }>>([{ id: 'a' }, { id: 'b' }])
    const def = defineController((ctx) => ({
      c: ctx.collection({
        source,
        keyOf: (i) => i.id,
        controller: item,
        propsOf: () => ({}),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.c.suspendItem('a')
    expect(root.c.isItemSuspended('a')).toBe(true)

    root.suspend()
    root.resume()

    expect(root.c.isItemSuspended('a')).toBe(true) // still suspended
    expect(root.c.isItemSuspended('b')).toBe(false) // resumed with the tree
    root.dispose()
  })

  test('(b) attach.suspend survives a tree cycle', () => {
    let resumes = 0
    const child = defineController((ctx) => {
      ctx.onResume(() => {
        resumes += 1
      })
      return {}
    })
    let handle: { suspend: () => void; resume: () => void } | undefined
    const def = defineController((ctx) => {
      handle = ctx.attach(child, undefined)
      return {}
    })
    const root = createRoot(def, { deps: emptyDeps })
    handle!.suspend()
    root.suspend()
    root.resume()
    expect(resumes).toBe(0) // the tree resume must NOT wake the suspended child
    handle!.resume()
    expect(resumes).toBe(1) // explicit resume does
    root.dispose()
  })

  test('(c) attach.resume under a suspended parent defers activation', () => {
    let resumes = 0
    const child = defineController((ctx) => {
      ctx.onResume(() => {
        resumes += 1
      })
      return {}
    })
    let handle: { suspend: () => void; resume: () => void } | undefined
    const def = defineController((ctx) => {
      handle = ctx.attach(child, undefined)
      return {}
    })
    const root = createRoot(def, { deps: emptyDeps })
    handle!.suspend()
    root.suspend()
    handle!.resume() // resume under a suspended parent → defer, don't activate now
    expect(resumes).toBe(0)
    root.resume() // parent resumes → the cleared child activates in the cascade
    expect(resumes).toBe(1)
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-L2.8 (T2.8) — minor batch. Effect CLEANUP throws must route to onError (the
// body was already guarded, the returned cleanup was not); collection.items /
// lazyChild.api are read-only at runtime (readOnly wrap), not just by type.
// ---------------------------------------------------------------------------
describe('regression: T2.8 minor batch (R-L2.8)', () => {
  test('an effect cleanup throw routes to onError', async () => {
    const { signal } = await import('../src/signals')
    const onError = vi.fn()
    const tick = signal(0)
    const def = defineController((ctx) => {
      ctx.effect(() => {
        tick.value // track
        return () => {
          throw new Error('cleanup-boom')
        }
      })
      return {}
    })
    const root = createRoot(def, { deps: emptyDeps, onError })
    tick.set(1) // re-run → the previous run's cleanup fires (and throws)
    await flush()
    const eff = onError.mock.calls.find((c) => (c[1] as { kind: string }).kind === 'effect')
    expect(eff).toBeTruthy()
    expect((eff![0] as Error).message).toBe('cleanup-boom')
    root.dispose()
  })

  test('collection.items is read-only at runtime (no set)', async () => {
    const { signal } = await import('../src/signals')
    const item = defineController(() => ({}))
    const source = signal<ReadonlyArray<{ id: string }>>([{ id: 'a' }])
    const def = defineController((ctx) => ({
      c: ctx.collection({ source, keyOf: (i) => i.id, controller: item, propsOf: () => ({}) }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect((root.c.items as unknown as { set?: unknown }).set).toBeUndefined()
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-Q3.1 (T3.1) — out-of-order rollback of parallel optimistic writes must not
// resurrect an earlier layer's delta. Chain-splice: rolling back a NON-top
// snapshot leaves the currently-displayed value untouched and threads that
// layer's captured baseline down onto the next layer, so once every layer has
// rolled back — in ANY order — data returns to the original pre-mutation value.
// Before the fix, rollback blindly wrote `record.prev`; with A then B applied
// and A rolling back first, B's later rollback restored the post-A value and
// resurrected A's delta. Only LIFO order was pinned (mutation.test.ts:362-409).
// ---------------------------------------------------------------------------
describe('regression: out-of-order optimistic rollback returns to baseline (R-Q3.1)', () => {
  test('Entry: A(+1) then B(+10); A rolls back first → final data is 0, not 1', () => {
    const entry = new Entry<number>({
      fetcher: () => () => Promise.resolve(0),
      initialData: 0,
    })
    const a = entry.setData((p) => (p ?? 0) + 1) // data 1
    const b = entry.setData((p) => (p ?? 0) + 10) // data 11
    expect(entry.data.peek()).toBe(11)

    // A fails FIRST — it is NOT the top of the stack. Chain-splice keeps the
    // currently-displayed value (both optimistic deltas still visible) and
    // rebases B's baseline down to A's pre-write value.
    a.rollback()
    expect(entry.data.peek()).toBe(11)

    // B fails — now the top layer. Restores the (spliced) baseline 0, NOT 1.
    b.rollback()
    expect(entry.data.peek()).toBe(0)
    expect(entry.hasPendingMutations.peek()).toBe(false)
    entry.dispose()
  })

  test('Entry: LIFO order still lands on the post-A intermediate then baseline', () => {
    const entry = new Entry<number>({
      fetcher: () => () => Promise.resolve(0),
      initialData: 0,
    })
    const a = entry.setData((p) => (p ?? 0) + 1) // data 1
    const b = entry.setData((p) => (p ?? 0) + 10) // data 11
    b.rollback() // top → post-A intermediate state
    expect(entry.data.peek()).toBe(1)
    a.rollback() // top → original baseline
    expect(entry.data.peek()).toBe(0)
    expect(entry.hasPendingMutations.peek()).toBe(false)
    entry.dispose()
  })

  test('InfiniteEntry: out-of-order page rollback returns to baseline pages', () => {
    const entry = new InfiniteEntry<number, number, number>({
      fetcher: () => Promise.resolve(0),
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    // Seed a canonical baseline page (track:false — no snapshot pushed).
    entry.setData(() => [0], { track: false })
    const a = entry.setData((p) => [(p?.[0] ?? 0) + 1]) // pages [1]
    const b = entry.setData((p) => [(p?.[0] ?? 0) + 10]) // pages [11]
    expect(entry.pages.peek()).toEqual([11])

    a.rollback() // non-top → pages untouched, B's baseline spliced to [0]
    expect(entry.pages.peek()).toEqual([11])

    b.rollback() // top → restores the spliced baseline [0], not [1]
    expect(entry.pages.peek()).toEqual([0])
    expect(entry.hasPendingMutations.peek()).toBe(false)
    entry.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-Q3.2 (T3.2) — refetchInterval must JOIN an in-flight fetch, not abort it.
// When fetch duration > interval, every tick previously called startFetch(),
// which aborts the current request and starts a new one → livelock: 0
// completions, data forever undefined, one aborted request per interval.
// ---------------------------------------------------------------------------
describe('regression: refetchInterval joins in-flight fetch (R-Q3.2)', () => {
  test('a fetch slower than the interval still completes and sets data', async () => {
    vi.useFakeTimers()
    let starts = 0
    let completions = 0
    const q = defineQuery({
      key: () => ['k'],
      fetcher: ({ signal }) => {
        starts += 1
        return new Promise<number>((resolve, reject) => {
          const t = setTimeout(() => {
            completions += 1
            resolve(completions)
          }, 2500) // slower than the 1000ms interval
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      },
      refetchInterval: 1000,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })

    await vi.advanceTimersByTimeAsync(10_000)

    // With the bug: every 1s tick aborts the 2.5s fetch → 0 completions, data
    // undefined, ~10 aborted starts. With the join: the fetch runs to
    // completion and ticks during a fetch are no-ops.
    expect(completions).toBeGreaterThanOrEqual(1)
    expect(root.x.data.value).not.toBeUndefined()
    // Did not hammer: far fewer starts than the ~10 ticks that elapsed.
    expect(starts).toBeLessThan(10)

    root.dispose()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// R-Q3.3 (T3.3) — a successful fetchNextPage / fetchPreviousPage while a full
// (invalidate) refetch is mid-flight must restore status to 'success'. The
// paging fetch supersedes the refetch (bumping the fetch id) but previously
// left `status` wedged at 'pending' — data present, isFetching false,
// firstValue() (Suspense) hanging forever.
// ---------------------------------------------------------------------------
describe('regression: infinite paging over a mid-flight refetch un-wedges status (R-Q3.3)', () => {
  test('fetchNextPage superseding an invalidate refetch restores success status', async () => {
    const calls: Array<{ pageParam: number; d: ReturnType<typeof deferred<number>> }> = []
    const entry = new InfiniteEntry<number, number, number>({
      fetcher: ({ pageParam, signal }) => {
        const d = deferred<number>()
        calls.push({ pageParam, d })
        signal.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')))
        return d.promise
      },
      initialPageParam: 0,
      getNextPageParam: (last) => (last === 0 ? 1 : null),
    })

    // Initial load → page [0], status success.
    entry.startFetch().catch(() => {})
    calls[0]!.d.resolve(0)
    await flush()
    expect(entry.pages.peek()).toEqual([0])
    expect(entry.status.peek()).toBe('success')

    // Invalidate → a full refetch goes in flight (status → pending); hold it.
    entry.invalidate().catch(() => {})
    expect(entry.status.peek()).toBe('pending')

    // User pages while revalidating → supersedes (aborts) the refetch.
    const paged = entry.fetchNextPage()
    const nextCall = calls[calls.length - 1]!
    expect(nextCall.pageParam).toBe(1)
    nextCall.d.resolve(1)
    await paged
    await flush()

    // Without the fix: status stays 'pending' and firstValue() hangs.
    expect(entry.pages.peek()).toEqual([0, 1])
    expect(entry.status.peek()).toBe('success')
    await expect(entry.firstValue()).resolves.toEqual([0, 1])

    entry.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-Q3.4 (T3.4) — cancellation API + snapshot rebase on fetch success. There
// was no way to cancel an in-flight fetch, so the canonical optimistic recipe
// ("cancel outgoing refetches, then setData") was unwritable and a stale
// response could clobber an optimistic write. Separately, a fetch landing
// during an optimistic mutation left the snapshot's baseline at the
// pre-fetch value, so a later rollback resurrected pre-refetch data.
// ---------------------------------------------------------------------------
describe('regression: query cancellation + snapshot rebase (R-Q3.4)', () => {
  const abortableEntry = (d: ReturnType<typeof deferred<number>>, initialData?: number) =>
    new Entry<number>({
      fetcher: () => (signal) =>
        new Promise<number>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          d.promise.then(resolve, reject)
        }),
      initialData,
    })

  test('cancel() mid-fetch: no data write, status restored, no unhandled rejection', async () => {
    const d = deferred<number>()
    const entry = abortableEntry(d, 1)
    const p = entry.refetch().catch(() => 'caught')
    expect(entry.isFetching.peek()).toBe(true)

    entry.cancel()
    expect(entry.isFetching.peek()).toBe(false)
    expect(entry.status.peek()).toBe('success') // data present → success
    expect(entry.data.peek()).toBe(1)

    // A late (superseded) response must not write.
    d.resolve(999)
    await flush()
    expect(entry.data.peek()).toBe(1)
    await expect(p).resolves.toBe('caught') // refetch rejected + caught
    entry.dispose()
  })

  test('cancel() with no data restores status to idle', async () => {
    const d = deferred<number>()
    const entry = abortableEntry(d) // no initialData → idle
    entry.refetch().catch(() => {})
    entry.cancel()
    expect(entry.status.peek()).toBe('idle')
    entry.dispose()
  })

  test('cancel-then-setData: the optimistic value survives a stale response', async () => {
    const d = deferred<number>()
    const entry = abortableEntry(d, 1)
    entry.refetch().catch(() => {})
    // Canonical recipe: cancel the outgoing refetch, THEN write optimistically.
    entry.cancel()
    entry.setData(() => 999)
    // The in-flight response lands late — must be superseded, not clobber 999.
    d.resolve(500)
    await flush()
    expect(entry.data.peek()).toBe(999)
    entry.dispose()
  })

  test('fetch success rebases live snapshots → rollback lands on server truth', async () => {
    const d = deferred<number>()
    const entry = abortableEntry(d, 0)
    // Optimistic write captures baseline 0.
    const snap = entry.setData(() => 5)
    expect(entry.data.peek()).toBe(5)
    // A refetch lands server truth 100 while the mutation is still pending.
    entry.refetch().catch(() => {})
    d.resolve(100)
    await flush()
    expect(entry.data.peek()).toBe(100)
    // Mutation fails → rollback. Must stay at server truth 100, not revert to 0.
    snap.rollback()
    expect(entry.data.peek()).toBe(100)
    expect(entry.hasPendingMutations.peek()).toBe(false)
    entry.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-Q3.6 (T3.6) — an optimistic rollback must re-emit a SetDataEvent so
// cross-tab / entity plugins drop the failed optimistic value. Before the fix,
// client.setData emitted on the optimistic write, but snapshot.rollback() wrote
// data directly (an Entry closure) with no emit — peer tabs kept the failed
// optimistic state forever.
// ---------------------------------------------------------------------------
describe('regression: optimistic rollback re-emits a SetDataEvent (R-Q3.6)', () => {
  test('rollback broadcasts the restored value with source:set, isRemote:false', async () => {
    type User = { id: string; name: string }
    const events: Array<{ source: string; data: unknown; isRemote: boolean; kind: string }> = []
    const q = defineQuery({
      queryId: 'r-q36-user',
      key: (id: string) => ['user', id] as const,
      fetcher: async (_ctx, id: string): Promise<User> => ({ id, name: 'server' }),
    })
    const capture: QueryClientPlugin = {
      name: 'capture',
      onSetData: (e) => {
        events.push({ source: e.source, data: e.data, isRemote: e.isRemote, kind: e.kind })
      },
    }
    const def = defineController((ctx) => ({ user: ctx.use(q, () => ['1'] as const) }))
    const root = createRoot(def, { deps: emptyDeps, plugins: [capture] })
    await vi.waitFor(() => expect(root.user.data.value).toEqual({ id: '1', name: 'server' }))

    // Optimistic write → broadcasts source:'set'.
    events.length = 0
    const snap = q.setData('1', (prev) => ({ ...(prev as User), name: 'optimistic' }))
    expect(root.user.data.value).toEqual({ id: '1', name: 'optimistic' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ source: 'set', isRemote: false, kind: 'data' })
    expect((events[0]!.data as User).name).toBe('optimistic')

    // Rollback → must broadcast the RESTORED value so peers drop the failed state.
    events.length = 0
    snap.rollback()
    expect(root.user.data.value).toEqual({ id: '1', name: 'server' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ source: 'set', isRemote: false, kind: 'data' })
    expect((events[0]!.data as User).name).toBe('server')

    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// R-Q3.7 (T3.7) — a background/interval refetch of an infinite entry must
// refetch ALL currently-loaded pages in place, not collapse to page one. The
// old refetch dropped every page but the first on each interval tick, so a
// scrolled-down infinite list truncated on every poll.
// ---------------------------------------------------------------------------
describe('regression: infinite interval refetch retains all pages (R-Q3.7)', () => {
  test('interval refetch re-fetches every loaded page in order, no collapse', async () => {
    vi.useFakeTimers()
    const pages: Record<number, { n: number; next: number | null }> = {
      0: { n: 0, next: 1 },
      1: { n: 1, next: 2 },
      2: { n: 2, next: null },
    }
    const calls: number[] = []
    const q = defineInfiniteQuery({
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number; signal: AbortSignal }) => {
        calls.push(pageParam)
        return pages[pageParam]!
      },
      initialPageParam: 0,
      getNextPageParam: (page) => page.next,
      refetchInterval: 1000,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    await root.x.fetchNextPage()
    await root.x.fetchNextPage()
    expect(root.x.pages.value.length).toBe(3)

    // One interval tick → refetch-all: fetches pages 0,1,2 in order; the pages
    // array stays length 3 (atomic update, no truncation flash).
    calls.length = 0
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toEqual([0, 1, 2])
    expect(root.x.pages.value.length).toBe(3)

    root.dispose()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// R-Q3.9 (T3.9) — minor batch. Each test pins one small correctness fix.
// ---------------------------------------------------------------------------
describe('regression: query minor batch (R-Q3.9)', () => {
  test('onMutate throw aborts the mutation: mutate never runs, run() rejects', async () => {
    let mutateCalled = false
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        onMutate: () => {
          throw new Error('onMutate boom')
        },
        mutate: async () => {
          mutateCalled = true
          return 'ok'
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await expect(root.save.run()).rejects.toThrow('onMutate boom')
    expect(mutateCalled).toBe(false)
    expect(root.save.isPending.value).toBe(false)
    root.dispose()
  })

  test('subscription.refetch() resolves (not AbortError-rejects) when superseded', async () => {
    const held: Array<(v: number) => void> = []
    let call = 0
    const q = defineQuery({
      key: () => ['s'],
      fetcher: ({ signal }: { signal: AbortSignal }) => {
        call += 1
        if (call === 1) return Promise.resolve(0) // initial
        if (call === 2) {
          // held refetch #1 — must reject on abort so the supersede unsticks it
          return new Promise<number>((res, rej) => {
            held.push(res)
            signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
          })
        }
        return Promise.resolve(42) // refetch #2 supersedes #1
      },
    })
    const def = defineController((ctx) => ({ sub: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.sub.data.value).toBe(0))

    const pA = root.sub.refetch() // call 2 (held)
    const pB = root.sub.refetch() // call 3 — supersedes A, resolves 42
    await expect(pB).resolves.toBe(42)
    // A was superseded — it must resolve with the superseder's outcome, not
    // reject with the spurious AbortError.
    await expect(pA).resolves.toBe(42)
    root.dispose()
  })

  test('default retry delay is exponential backoff when retry > 0 and no retryDelay', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const entry = new Entry<number>({
      fetcher: () => async () => {
        attempts += 1
        throw new Error('fail')
      },
      retry: 3, // no retryDelay → should be exponential min(1000 * 2**attempt, 30_000)
    })
    entry.refetch().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1000) // 1st retry after 1000ms
    expect(attempts).toBe(2)
    // 2nd retry is at +2000ms (a constant-1000 default would already have fired).
    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts).toBe(3)
    entry.dispose()
    vi.useRealTimers()
  })

  test('dispose mid-fetch resets isFetching so waitForIdle cannot hang', async () => {
    const d = deferred<number>()
    const entry = new Entry<number>({
      fetcher: () => (signal) =>
        new Promise<number>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          d.promise.then(resolve, reject)
        }),
    })
    entry.startFetch().catch(() => {})
    expect(entry.isFetching.peek()).toBe(true)
    entry.dispose()
    expect(entry.isFetching.peek()).toBe(false)
  })

  test('invalidate on a subscriber-less entry marks stale only; refetches on next subscribe', async () => {
    const calls: Record<string, number> = {}
    const q = defineQuery({
      key: (id: string) => ['orphan', id],
      fetcher: async (_ctx, id: string) => {
        calls[id] = (calls[id] ?? 0) + 1
        return `${id}:${calls[id]}`
      },
      gcTime: 60_000, // keep the released entry alive
      staleTime: 60_000, // fresh — so only invalidate can force a re-subscribe refetch
    })
    const idSig = signal('a')
    const def = defineController((ctx) => ({ x: ctx.use(q, () => [idSig.value]) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(calls.a).toBe(1))

    // Switch key → entry 'a' is released (subscriber-less), kept alive by gcTime.
    idSig.set('b')
    await vi.waitFor(() => expect(calls.b).toBe(1))

    // Invalidate the subscriber-less 'a' — spec §5.7: refetch only IF subscribed.
    // So it must NOT refetch now; just mark stale.
    q.invalidate('a')
    await flush()
    expect(calls.a).toBe(1)

    // Re-subscribe to 'a' — now it refetches, because invalidate marked it stale.
    idSig.set('a')
    await vi.waitFor(() => expect(calls.a).toBe(2))

    root.dispose()
  })

  test('a different query overwriting a queryId dev-warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    defineQuery({ queryId: 'r-q39-dup', key: () => ['a'], fetcher: async () => 1 })
    expect(warn).not.toHaveBeenCalled()
    // Re-register the SAME id with a DIFFERENT query object → collision warning.
    defineQuery({ queryId: 'r-q39-dup', key: () => ['b'], fetcher: async () => 2 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate queryId'))
    warn.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// R-F5.1 (T5.1) — structural FieldArray edits (add/remove/move/clear) must mark
// the array dirty. Otherwise a reactive `initial: () => queryData` + the default
// `resetOnInitialChange: 'when-clean'` re-seats the array on a background refetch
// and silently deletes rows the user just added.
// ---------------------------------------------------------------------------
describe('regression: structural FieldArray edits mark isDirty (R-F5.1)', () => {
  test('add / remove / move flip isDirty; reset clears it', () => {
    const def = defineController((ctx) => ({
      arr: ctx.fieldArray((initial) => ctx.field<string>((initial as string) ?? ''), {
        initial: ['a', 'b', 'c'],
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.arr.isDirty.value).toBe(false) // construction is not dirty

    root.arr.remove(0)
    expect(root.arr.isDirty.value).toBe(true) // structural remove
    root.arr.reset()
    expect(root.arr.isDirty.value).toBe(false) // reset clears structural dirt

    root.arr.move(0, 2)
    expect(root.arr.isDirty.value).toBe(true) // structural move
    root.arr.reset()
    expect(root.arr.isDirty.value).toBe(false)

    root.arr.add('d')
    expect(root.arr.isDirty.value).toBe(true) // structural add
    root.dispose()
  })

  test('a user-added row survives a background initial change (the critical bug)', async () => {
    const { signal } = await import('../src/signals')
    const seed = signal<string[]>(['a', 'b'])
    const def = defineController((ctx) => ({
      form: ctx.form(
        { tags: ctx.fieldArray((initial) => ctx.field<string>((initial as string) ?? '')) },
        { initial: () => ({ tags: seed.value }) },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.fields.tags.size.value).toBe(2)

    // User adds a row → the form is now structurally dirty.
    root.form.fields.tags.add('c')
    expect(root.form.fields.tags.size.value).toBe(3)
    expect(root.form.isDirty.value).toBe(true)

    // Background refetch changes the reactive initial. `when-clean` must REFUSE
    // to re-seat (form is dirty) — the user's row must survive.
    seed.set(['x', 'y'])
    expect(root.form.fields.tags.size.value).toBe(3)
    expect(root.form.fields.tags.at(2)?.value).toBe('c')
    root.dispose()
  })
})
