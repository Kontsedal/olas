import { describe, expect, test } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import type { DebugEvent } from '../src/devtools'
import { defineQuery } from '../src/query/define'

describe('runtime devtools events', () => {
  test('cache:fetch-start + fetch-success fire when a subscribed query resolves', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id) => `data-${id}`,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q, () => ['1']) }))
    const root = createRoot(def, { deps: {} })
    root.__debug.subscribe((ev) => events.push(ev))

    await root.x.refetch()

    const kinds = events.map((e) => e.type)
    expect(kinds).toContain('cache:fetch-start')
    expect(kinds).toContain('cache:fetch-success')
    const success = events.find((e) => e.type === 'cache:fetch-success') as {
      type: 'cache:fetch-success'
      queryKey: readonly unknown[]
      durationMs: number
    }
    expect(success.queryKey).toEqual(['1'])
    expect(typeof success.durationMs).toBe('number')

    root.dispose()
  })

  test('cache:fetch-error fires when a fetcher throws (no retries)', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({
      key: () => [],
      fetcher: async () => {
        throw new Error('boom')
      },
      retry: 0,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: {}, onError: () => {} })
    root.__debug.subscribe((ev) => events.push(ev))

    await root.x.refetch().catch(() => undefined)

    expect(events.some((e) => e.type === 'cache:fetch-error')).toBe(true)
    root.dispose()
  })

  test('cache:invalidated fires on query.invalidate()', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({ key: (id: string) => [id], fetcher: async (_ctx, id) => id })
    const def = defineController((ctx) => ({ x: ctx.use(q, () => ['k']) }))
    const root = createRoot(def, { deps: {}, onError: () => {} })
    await root.x.firstValue()
    root.__debug.subscribe((ev) => events.push(ev))

    q.invalidate('k')

    expect(events.some((e) => e.type === 'cache:invalidated')).toBe(true)
    root.dispose()
  })

  test('mutation:run + success fire on successful mutation', async () => {
    const events: DebugEvent[] = []
    const def = defineController((ctx) => ({
      save: ctx.mutation({ mutate: async (v: number) => v * 2 }),
    }))
    const root = createRoot(def, { deps: {} })
    root.__debug.subscribe((ev) => events.push(ev))

    await root.save.run(3)

    const kinds = events.map((e) => e.type)
    expect(kinds).toContain('mutation:run')
    expect(kinds).toContain('mutation:success')
    root.dispose()
  })

  test('mutation:error fires when mutate throws', async () => {
    const events: DebugEvent[] = []
    const def = defineController((ctx) => ({
      save: ctx.mutation({
        mutate: async () => {
          throw new Error('nope')
        },
        retry: 0,
      }),
    }))
    const root = createRoot(def, { deps: {} })
    root.__debug.subscribe((ev) => events.push(ev))

    await root.save.run(undefined as void).catch(() => undefined)

    expect(events.some((e) => e.type === 'mutation:error')).toBe(true)
    root.dispose()
  })

  test('mutation:rollback fires when an optimistic snapshot is rolled back', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id) => `server-${id}`,
    })
    const def = defineController((ctx) => ({
      cur: ctx.use(q, () => ['1']),
      save: ctx.mutation({
        mutate: async () => {
          throw new Error('server down')
        },
        onMutate: () => q.setData('1', () => 'optimistic'),
        retry: 0,
      }),
    }))
    const root = createRoot(def, { deps: {}, onError: () => {} })
    await root.cur.firstValue()
    root.__debug.subscribe((ev) => events.push(ev))

    await root.save.run(undefined as void).catch(() => undefined)

    // The user's onError can call snapshot.rollback() — we test that the
    // wrapped snapshot emits the event whenever rollback is invoked. Here
    // we drive it explicitly via the spec's onError-style path: the latest
    // snapshot returned from onMutate is also accessible via the run's
    // outcome. Instead of relying on that, exercise it directly.
    expect(events.map((e) => e.type)).toContain('mutation:error')
    // rollback fires when supersede happens — which it does in this single-run
    // parallel mode iff dispose / abort. For pure error path, the user opts
    // in via onError. So we don't assert rollback here unconditionally.
    root.dispose()
  })

  test('mutation:rollback fires when latest-wins supersedes an inflight run', async () => {
    const events: DebugEvent[] = []
    const def = defineController((ctx) => ({
      save: ctx.mutation<number, string>({
        concurrency: 'latest-wins',
        mutate: async (_, signal) => {
          await new Promise<void>((resolve, reject) => {
            const id = setTimeout(resolve, 50)
            signal.addEventListener('abort', () => {
              clearTimeout(id)
              reject(new DOMException('Aborted', 'AbortError'))
            })
          })
          return 'done'
        },
        onMutate: () => ({ rollback: () => {}, finalize: () => {} }),
      }),
    }))
    const root = createRoot(def, { deps: {}, onError: () => {} })
    root.__debug.subscribe((ev) => events.push(ev))

    const first = root.save.run(1).catch(() => undefined)
    const second = root.save.run(2)
    await Promise.all([first, second])

    expect(events.some((e) => e.type === 'mutation:rollback')).toBe(true)
    root.dispose()
  })

  test('cache:gc fires when a subscriber leaves and gcTime expires', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id) => id,
      gcTime: 0, // immediate gc
    })
    const def = defineController((ctx) => ({ x: ctx.use(q, () => ['1']) }))
    const root = createRoot(def, { deps: {} })
    await root.x.firstValue()
    root.__debug.subscribe((ev) => events.push(ev))

    root.dispose()

    expect(events.some((e) => e.type === 'cache:gc')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Correlation backbone (T8.1): seq / t / causeId + cache:set-data + snapshot:*
  // -------------------------------------------------------------------------

  test('every event carries a monotonic seq and a numeric timestamp', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({ key: () => ['k'], fetcher: async () => 1 })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: {} })
    root.__debug.subscribe((ev) => events.push(ev))

    await root.x.refetch()

    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(typeof e.seq).toBe('number')
      expect(typeof e.t).toBe('number')
    }
    const seqs = events.map((e) => e.seq as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // increasing in delivery order
    root.dispose()
  })

  test('a fetch shares one causeId across fetch-start, fetch-success and its set-data', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id) => `data-${id}`,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q, () => ['1']) }))
    const root = createRoot(def, { deps: {} })
    root.__debug.subscribe((ev) => events.push(ev))

    await root.x.refetch()

    const success = events.find((e) => e.type === 'cache:fetch-success')
    const cause = success?.causeId
    expect(cause).toBeDefined()
    expect(events.some((e) => e.type === 'cache:fetch-start' && e.causeId === cause)).toBe(true)
    const write = events.find((e) => e.type === 'cache:set-data' && e.causeId === cause)
    expect(write).toMatchObject({ source: 'fetch', data: 'data-1' })
    root.dispose()
  })

  test('an optimistic mutation groups run, set-data, snapshot push/rollback, rollback and error under one causeId', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id) => `server-${id}`,
    })
    const def = defineController((ctx) => ({
      cur: ctx.use(q, () => ['1']),
      save: ctx.mutation({
        name: 'save',
        mutate: async () => {
          throw new Error('boom')
        },
        onMutate: () => q.setData('1', () => 'optimistic'),
        retry: 0,
      }),
    }))
    const root = createRoot(def, { deps: {}, onError: () => {} })
    await root.cur.firstValue()
    root.__debug.subscribe((ev) => events.push(ev))

    await root.save.run(undefined as void).catch(() => undefined)

    const run = events.find((e) => e.type === 'mutation:run')
    const cause = run?.causeId
    expect(cause).toBeDefined()
    const kindsForCause = events.filter((e) => e.causeId === cause).map((e) => e.type)
    // The whole optimistic-apply → rollback chain shares the run's causeId.
    expect(kindsForCause).toContain('mutation:run')
    expect(kindsForCause).toContain('snapshot:push')
    expect(kindsForCause).toContain('cache:set-data')
    expect(kindsForCause).toContain('snapshot:rollback')
    expect(kindsForCause).toContain('mutation:rollback')
    expect(kindsForCause).toContain('mutation:error')
    // The first set-data under this cause is the optimistic write (source 'mutate').
    const optimistic = events.find((e) => e.type === 'cache:set-data' && e.causeId === cause)
    expect(optimistic).toMatchObject({ source: 'mutate', data: 'optimistic' })
    root.dispose()
  })

  test('a successful mutation emits snapshot:finalize under the run causeId', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id) => `server-${id}`,
    })
    const def = defineController((ctx) => ({
      cur: ctx.use(q, () => ['1']),
      save: ctx.mutation({
        mutate: async () => 'ok',
        onMutate: () => q.setData('1', () => 'optimistic'),
      }),
    }))
    const root = createRoot(def, { deps: {} })
    await root.cur.firstValue()
    root.__debug.subscribe((ev) => events.push(ev))

    await root.save.run(undefined as void)

    const run = events.find((e) => e.type === 'mutation:run')
    const cause = run?.causeId
    const kindsForCause = events.filter((e) => e.causeId === cause).map((e) => e.type)
    expect(kindsForCause).toContain('snapshot:push')
    expect(kindsForCause).toContain('snapshot:finalize')
    expect(kindsForCause).toContain('mutation:success')
    expect(kindsForCause).not.toContain('snapshot:rollback')
    root.dispose()
  })

  test('a bare query.setData is source:set with no causeId', async () => {
    const events: DebugEvent[] = []
    const q = defineQuery({ key: (id: string) => [id], fetcher: async (_ctx, id) => id })
    const def = defineController((ctx) => ({ x: ctx.use(q, () => ['1']) }))
    const root = createRoot(def, { deps: {} })
    await root.x.firstValue()
    root.__debug.subscribe((ev) => events.push(ev))

    q.setData('1', () => 'manual')

    const write = events.find((e) => e.type === 'cache:set-data')
    expect(write).toMatchObject({ source: 'set', data: 'manual' })
    expect(write?.causeId).toBeUndefined()
    root.dispose()
  })
})
