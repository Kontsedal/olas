import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import type { QueryActions } from '../src/query/types'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose()
})
const keep = <T extends { dispose(): void }>(root: T): T => {
  roots.push(root)
  return root
}

describe('query operations are scoped to one root', () => {
  test('bound reads, writes and optimistic rollback cannot cross request boundaries', async () => {
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async ({ deps }) => deps.user as string,
      staleTime: Infinity,
    })
    const def = defineController((ctx) => ({
      sub: ctx.use(q, () => ['me']),
      actions: ctx.bindQuery(q),
    }))
    const alice = keep(createRoot(def, { deps: { user: 'Alice' } }))
    const bob = keep(createRoot(def, { deps: { user: 'Bob' } }))
    await Promise.all([alice.waitForIdle(), bob.waitForIdle()])
    expectTypeOf(alice.actions).toEqualTypeOf<QueryActions<[id: string], string>>()
    expect(alice.actions.peek('me')).toBe('Alice')
    expect(bob.actions.peek('me')).toBe('Bob')
    const snapshot = alice.actions.setData('me', () => 'optimistic')
    expect(alice.sub.hasPendingMutations.peek()).toBe(true)
    expect(bob.sub.hasPendingMutations.peek()).toBe(false)
    expect(bob.sub.data.peek()).toBe('Bob')
    snapshot.rollback()
    expect(alice.sub.data.peek()).toBe('Alice')
    alice.actions.write('me', (prev) => `${prev} edited`)
    expect(alice.sub.data.peek()).toBe('Alice edited')
    alice.bindQuery(q).replace('me', 'Alice replaced')
    expect(alice.sub.data.peek()).toBe('Alice replaced')
    expect(bob.sub.data.peek()).toBe('Bob')
  })

  test('all ambiguous unbound operations fail before fetching or changing data', async () => {
    const fetcher = vi.fn(async () => 'original')
    const q = defineQuery({ key: () => [], fetcher, staleTime: Infinity })
    const def = defineController((ctx) => ({ sub: ctx.use(q) }))
    const a = keep(createRoot(def, { deps: {} }))
    const b = keep(createRoot(def, { deps: {} }))
    await Promise.all([a.waitForIdle(), b.waitForIdle()])
    const updater = vi.fn(() => 'changed')
    for (const operation of [
      () => q.peek(),
      () => q.write(updater),
      () => q.replace('changed'),
      () => q.setData(updater),
      () => q.cancel(),
      () => q.cancelAll(),
    ]) {
      expect(operation).toThrow(/ambiguous.*multiple roots/)
    }
    await expect(q.prefetch()).rejects.toThrow(/bindQuery/)
    await expect(q.invalidate()).rejects.toThrow(/bindQuery/)
    await expect(q.invalidateAll()).rejects.toThrow(/bindQuery/)
    expect(updater).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(a.sub.data.peek()).toBe('original')
    expect(b.sub.data.peek()).toBe('original')
    a.dispose()
    q.write(() => 'single remaining root')
    expect(b.sub.data.peek()).toBe('single remaining root')
  })

  test('bound prefetch works before subscriptions and rejects after root disposal', async () => {
    const q = defineQuery({
      key: (id: number) => [id],
      fetcher: async ({ deps }, id: number) => `${deps.user}:${id}`,
      staleTime: Infinity,
    })
    const def = defineController(() => ({}))
    const a = keep(createRoot(def, { deps: { user: 'Alice' } }))
    const b = keep(createRoot(def, { deps: { user: 'Bob' } }))
    const qa = a.bindQuery(q)
    const qb = b.bindQuery(q)
    expect(qa.peek(1)).toBeUndefined()
    await expect(qa.prefetch(1)).resolves.toBe('Alice:1')
    await expect(qb.prefetch(1)).resolves.toBe('Bob:1')
    a.dispose()
    expect(() => qa.write(1, () => 'resurrected')).toThrow(/disposal/)
    expect(() => a.bindQuery(q)).toThrow(/disposal/)
    await expect(qa.prefetch(1)).rejects.toThrow(/disposal/)
    expect(qb.peek(1)).toBe('Bob:1')
  })

  test('invalidateAll refetches every local key and leaves other roots alone', async () => {
    const calls: string[] = []
    const q = defineQuery({
      key: (id: number) => [id],
      fetcher: async ({ deps }, id: number) => {
        const value = `${deps.user}:${id}`
        calls.push(value)
        return value
      },
      staleTime: Infinity,
    })
    const def = defineController((ctx) => ({
      first: ctx.use(q, () => [1]),
      second: ctx.use(q, () => [2]),
    }))
    const a = keep(createRoot(def, { deps: { user: 'Alice' } }))
    const b = keep(createRoot(def, { deps: { user: 'Bob' } }))
    await Promise.all([a.waitForIdle(), b.waitForIdle()])
    calls.length = 0
    await a.bindQuery(q).invalidateAll()
    expect(calls.sort()).toEqual(['Alice:1', 'Alice:2'])
    calls.length = 0
    await b.bindQuery(q).invalidate(2)
    expect(calls).toEqual(['Bob:2'])
  })

  test.each([
    'cancel',
    'cancelAll',
  ] as const)('%s only aborts the selected root', async (method) => {
    const signals: AbortSignal[] = []
    const q = defineQuery({
      key: () => [],
      fetcher: async ({ signal }) => {
        signals.push(signal)
        return new Promise<string>(() => {})
      },
    })
    const def = defineController((ctx) => ({ sub: ctx.use(q) }))
    const a = keep(createRoot(def, { deps: {} }))
    const b = keep(createRoot(def, { deps: {} }))
    expect(signals).toHaveLength(2)
    a.bindQuery(q)[method]()
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    expect(b.sub.isFetching.peek()).toBe(true)
  })

  test('infinite query operations use the selected root, including ambiguity guards', async () => {
    const calls: string[] = []
    const q = defineInfiniteQuery({
      key: () => [],
      fetcher: async ({ deps }) => {
        calls.push(deps.user as string)
        return deps.user as string
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: Infinity,
    })
    const def = defineController((ctx) => ({ sub: ctx.use(q), actions: ctx.bindQuery(q) }))
    const a = keep(createRoot(def, { deps: { user: 'Alice' } }))
    const b = keep(createRoot(def, { deps: { user: 'Bob' } }))
    await Promise.all([a.waitForIdle(), b.waitForIdle()])
    expect(() => q.setData(() => ['bad'])).toThrow(/ambiguous/)
    expect(() => q.cancel()).toThrow(/ambiguous/)
    expect(() => q.cancelAll()).toThrow(/ambiguous/)
    await expect(q.prefetch()).rejects.toThrow(/ambiguous/)
    await expect(q.invalidate()).rejects.toThrow(/ambiguous/)
    await expect(q.invalidateAll()).rejects.toThrow(/ambiguous/)
    const snap = a.actions.setData(() => ['edited'])
    expect(a.sub.pages.peek()).toEqual(['edited'])
    expect(b.sub.pages.peek()).toEqual(['Bob'])
    snap.rollback()
    expect(a.sub.pages.peek()).toEqual(['Alice'])
    a.actions.setData(() => ['committed']).finalize()
    expect(a.sub.hasPendingMutations.peek()).toBe(false)
    calls.length = 0
    await a.actions.invalidateAll()
    expect(calls).toEqual(['Alice'])
    await expect(b.actions.prefetch()).resolves.toBe('Bob')
  })
})
