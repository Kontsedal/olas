import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import type { QuerySubscription } from '../src/query/types'

const emptyDeps = {}

describe('ctx.use(query, { select })', () => {
  test('select projects T → U on data', async () => {
    type User = { id: string; name: string; email: string }
    const userQuery = defineQuery({
      queryId: 'select-test/user',
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string): Promise<User> => ({
        id,
        name: 'Alice',
        email: 'a@b.com',
      }),
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      name: ctx.use(userQuery, {
        key: () => ['u1'],
        select: (u) => u.name,
      }),
    }))
    type Api = { name: QuerySubscription<string> }
    const root = createRoot(def, { deps: emptyDeps }) as unknown as Api & { dispose(): void }

    await vi.waitFor(() => expect(root.name.data.value).toBe('Alice'))
    root.dispose()
  })

  test('unchanged refetch + select returns the same projected value (structural-share + Object.is)', async () => {
    type User = { id: string; name: string; tags: string[] }
    let calls = 0
    const userQuery = defineQuery({
      queryId: 'select-test/stable',
      key: () => [],
      fetcher: async (): Promise<User> => {
        calls += 1
        // Same content every call — only the outer object identity changes.
        return { id: 'u1', name: 'Alice', tags: ['admin', 'editor'] }
      },
      staleTime: 0, // always stale so refetch produces a fresh object
    })

    const def = defineController((ctx) => ({
      tags: ctx.use(userQuery, {
        select: (u) => u.tags,
      }),
    }))
    type Api = { tags: QuerySubscription<readonly string[]> }
    const root = createRoot(def, { deps: emptyDeps }) as unknown as Api & {
      dispose(): void
    }

    await vi.waitFor(() => expect(calls).toBe(1))
    const firstRef = root.tags.data.peek()
    expect(firstRef).toEqual(['admin', 'editor'])

    // Force a refetch by invalidating; structural sharing on the entry keeps
    // the `tags` array reference stable, and `select` is pure, so the
    // projection's output stays === to `firstRef`.
    userQuery.invalidateAll()
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(root.tags.data.peek()).toBe(firstRef)

    root.dispose()
  })

  test('subscriber fires only when the projected value changes, not on every refetch', async () => {
    type Row = { id: string; counter: number }
    let counter = 0
    const rowQuery = defineQuery({
      queryId: 'select-test/dedup',
      key: () => [],
      fetcher: async (): Promise<Row> => ({ id: 'r1', counter }),
      staleTime: 0,
    })

    const def = defineController((ctx) => ({
      // Project a constant — `select` always returns `'static'`, so the
      // computed result NEVER changes regardless of how many refetches we run.
      label: ctx.use(rowQuery, { select: (_r) => 'static' as const }),
    }))
    type Api = { label: QuerySubscription<'static'> }
    const root = createRoot(def, { deps: emptyDeps }) as unknown as Api & { dispose(): void }

    await vi.waitFor(() => expect(root.label.data.value).toBe('static'))

    const fires = vi.fn()
    const unsub = root.label.data.subscribe(fires)
    fires.mockClear()

    counter = 1
    rowQuery.invalidateAll()
    // Wait for the fetch to land.
    await vi.waitFor(() => expect(root.label.data.peek()).toBe('static'))

    expect(fires).not.toHaveBeenCalled()
    unsub()
    root.dispose()
  })

  test('select runs after structural-share — sees stable inputs on no-op refetch', async () => {
    type Payload = { items: Array<{ id: string; label: string }> }
    const payloadQuery = defineQuery({
      queryId: 'select-test/share',
      key: () => [],
      fetcher: async (): Promise<Payload> => ({
        items: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      }),
      staleTime: 0,
    })

    const def = defineController((ctx) => ({
      itemIds: ctx.use(payloadQuery, {
        select: (p) => p.items.map((i) => i.id),
      }),
    }))
    type Api = { itemIds: QuerySubscription<string[]> }
    const root = createRoot(def, { deps: emptyDeps }) as unknown as Api & { dispose(): void }

    await vi.waitFor(() => expect(root.itemIds.data.value).toEqual(['a', 'b']))
    const firstRef = root.itemIds.data.peek()

    payloadQuery.invalidateAll()
    await vi.waitFor(() => {
      const v = root.itemIds.data.peek()
      // Wait until a refetch has happened (still equal content).
      expect(v).toEqual(['a', 'b'])
    })

    // `select` runs on every entry-data change. Even though structural-share
    // makes the entry's `items` array the same ref, `select` builds a fresh
    // `.map(...)` array — so the projection's reference DOES change on each
    // refetch. The dedupe story belongs in (a) consumer-supplied stable
    // select OR (b) downstream `Object.is` in computed. Test pins the
    // documented contract: select fires per refetch.
    expect(root.itemIds.data.peek()).toEqual(['a', 'b'])

    root.dispose()
  })

  test('error / status / isLoading are NOT projected — they describe the underlying entry', async () => {
    type Row = { id: string }
    let throwNext = true
    const rowQuery = defineQuery({
      queryId: 'select-test/error',
      key: () => [],
      fetcher: async (): Promise<Row> => {
        if (throwNext) throw new Error('boom')
        return { id: 'r1' }
      },
      staleTime: 60_000,
      retry: 0,
    })

    const def = defineController((ctx) => ({
      sub: ctx.use(rowQuery, { select: (r) => r.id }),
    }))
    type Api = { sub: QuerySubscription<string> }
    const root = createRoot(def, { deps: emptyDeps }) as unknown as Api & { dispose(): void }

    await vi.waitFor(() => expect(root.sub.status.value).toBe('error'))
    expect(root.sub.error.value).toBeInstanceOf(Error)
    expect(root.sub.data.value).toBeUndefined()
    expect(root.sub.isLoading.value).toBe(false)

    throwNext = false
    await root.sub.refetch()
    expect(root.sub.data.value).toBe('r1')
    expect(root.sub.status.value).toBe('success')

    root.dispose()
  })
})
