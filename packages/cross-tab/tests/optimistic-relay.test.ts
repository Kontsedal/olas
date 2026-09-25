import {
  bindQuery,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  type Query,
  queryEngine,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChannelLike } from '../src/channel'
import { crossTabPlugin } from '../src/plugin'
import { PROTOCOL_VERSION } from '../src/protocol'

/**
 * What a peer's write means in the tab that receives it. A peer's guess used
 * to arrive as a canonical write: it restarted this tab's stale clock, and
 * the plugins that keep server truth took it as server data (the persister
 * and entities cases are in `packages/integration`). A peer's `replace`
 * arrived as a patch too, so a fetch this tab had in flight overwrote it. The
 * message now carries its source, and each source is applied as what it is.
 */

type Listener = (event: { data: unknown }) => void
const buses = new Map<string, Set<Listener>>()
afterEach(() => {
  buses.clear()
  vi.useRealTimers()
})

function bus(): (name: string) => ChannelLike {
  return (name) => {
    const listeners = buses.get(name) ?? new Set<Listener>()
    buses.set(name, listeners)
    const mine = new Set<Listener>()
    return {
      postMessage(data) {
        for (const l of listeners) if (!mine.has(l)) queueMicrotask(() => l({ data }))
      },
      addEventListener(_type, l) {
        listeners.add(l)
        mine.add(l)
      },
      removeEventListener(_type, l) {
        listeners.delete(l)
        mine.delete(l)
      },
      close() {
        for (const l of mine) listeners.delete(l)
      },
    }
  }
}

type Post = { title: string; likes: number }

/** One query value per tab, as each tab evaluates its own modules. */
const postQuery = (id: string, fetcher?: () => Promise<Post>): Query<[], Post> =>
  defineQuery({
    id,
    key: () => [],
    fetcher: fetcher ?? (async () => ({ title: 'Hello', likes: 0 })),
    staleTime: 1_000,
    meta: { crossTab: true },
  })

function tab(
  q: Query<[], Post>,
  channel: (name: string) => ChannelLike,
  options: { optimistic?: boolean } = {},
) {
  return createRoot(
    defineController((ctx) => ({ post: createQuery(ctx, q), posts: bindQuery(ctx, q) })),
    {
      queries: queryEngine(),
      deps: {},
      plugins: [
        crossTabPlugin({
          channelName: 'relay',
          channelFactory: channel,
          ...(options.optimistic !== undefined ? { optimistic: options.optimistic } : {}),
        }),
      ],
    },
  )
}

describe("crossTabPlugin — a peer's guess stays a guess", () => {
  test('it restarts no stale clock, and stays pending until the peer settles it', async () => {
    vi.useFakeTimers()
    const channel = bus()
    const a = tab(postQuery('relay/stale'), channel)
    const b = tab(postQuery('relay/stale'), channel)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000) // both past staleTime
    expect(a.api.post.isStale.peek()).toBe(true)
    expect(b.api.post.isStale.peek()).toBe(true)

    a.api.posts.setData(() => ({ title: 'Hello', likes: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(b.api.post.data.peek()).toEqual({ title: 'Hello', likes: 1 }) // shown
    expect(a.api.post.isStale.peek()).toBe(true)
    expect(b.api.post.isStale.peek()).toBe(true)
    expect(b.api.post.hasPendingMutations.peek()).toBe(true)
    a.dispose()
    b.dispose()
  })

  test("the peer's rollback removes it, and the peer's commit makes it this tab's data", async () => {
    const channel = bus()
    const a = tab(postQuery('relay/settle'), channel)
    const b = tab(postQuery('relay/settle'), channel)
    await a.waitForIdle()
    await b.waitForIdle()

    const failed = a.api.posts.setData(() => ({ title: 'Hello', likes: 1 }))
    await Promise.resolve()
    failed.rollback()
    await b.waitForIdle()
    expect(b.api.post.data.peek()).toEqual({ title: 'Hello', likes: 0 })
    expect(b.api.post.hasPendingMutations.peek()).toBe(false)

    const liked = a.api.posts.setData(() => ({ title: 'Hello', likes: 1 }))
    await Promise.resolve()
    liked.finalize()
    await b.waitForIdle()
    expect(b.api.post.data.peek()).toEqual({ title: 'Hello', likes: 1 })
    expect(b.api.post.hasPendingMutations.peek()).toBe(false)
    a.dispose()
    b.dispose()
  })

  test.each([
    ['optimistic: true', true],
    ['optimistic: false', false],
  ])(
    'with %s, a commit ends both tabs on the committed value, stale as it was',
    async (_l, optimistic) => {
      vi.useFakeTimers()
      const channel = bus()
      const a = tab(postQuery(`relay/commit-${optimistic}`), channel, { optimistic })
      const b = tab(postQuery(`relay/commit-${optimistic}`), channel, { optimistic })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2_000)

      const like = a.api.posts.setData(() => ({ title: 'Hello', likes: 1 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(b.api.post.data.peek()).toEqual(
        optimistic ? { title: 'Hello', likes: 1 } : { title: 'Hello', likes: 0 },
      )
      like.finalize()
      await vi.advanceTimersByTimeAsync(0)
      expect(a.api.post.data.peek()).toEqual({ title: 'Hello', likes: 1 })
      expect(b.api.post.data.peek()).toEqual({ title: 'Hello', likes: 1 })
      expect(b.api.post.isStale.peek()).toBe(true)
      expect(b.api.post.hasPendingMutations.peek()).toBe(false)
      a.dispose()
      b.dispose()
    },
  )

  test('a canonical write under a peer guess reaches this tab as server truth', async () => {
    const channel = bus()
    const a = tab(postQuery('relay/write-under-guess'), channel)
    const b = tab(postQuery('relay/write-under-guess'), channel)
    await a.waitForIdle()
    await b.waitForIdle()

    const like = a.api.posts.setData(() => ({ title: 'Hello', likes: 1 }))
    a.api.posts.write((p) => ({ ...p!, title: 'Renamed' }))
    await b.waitForIdle()
    expect(b.api.post.data.peek()).toEqual({ title: 'Renamed', likes: 1 })

    like.rollback()
    await b.waitForIdle()
    expect(a.api.post.data.peek()).toEqual({ title: 'Renamed', likes: 0 })
    expect(b.api.post.data.peek()).toEqual({ title: 'Renamed', likes: 0 })
    expect(b.api.post.hasPendingMutations.peek()).toBe(false)
    a.dispose()
    b.dispose()
  })

  test('a guess whose tab went away without settling it expires', async () => {
    vi.useFakeTimers()
    const channel = bus()
    const a = tab(postQuery('relay/orphan'), channel)
    const b = tab(postQuery('relay/orphan'), channel)
    await vi.advanceTimersByTimeAsync(0)
    a.api.posts.setData(() => ({ title: 'Hello', likes: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    a.dispose() // closed before its mutation settled
    expect(b.api.post.hasPendingMutations.peek()).toBe(true)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(b.api.post.data.peek()).toEqual({ title: 'Hello', likes: 0 })
    expect(b.api.post.hasPendingMutations.peek()).toBe(false)
    b.dispose()
  })
})

describe("crossTabPlugin — a peer's replace", () => {
  // Tab A replaces the record with the server's read-back after a mutation.
  // Tab B has a refetch in flight that started before the mutation. A patch
  // leaves that fetch alone (§6.4), so its older response landed last.
  test('supersedes the fetch this tab has in flight, as a replace does', async () => {
    const channel = bus()
    let respond: (p: Post) => void = () => {}
    let calls = 0
    const slow = async (): Promise<Post> => {
      calls += 1
      if (calls === 1) return { title: 'v1', likes: 0 }
      return new Promise<Post>((resolve) => {
        respond = resolve
      })
    }
    const a = tab(postQuery('relay/replace'), channel)
    const b = tab(postQuery('relay/replace', slow), channel)
    await a.waitForIdle()
    await b.waitForIdle()

    void b.api.post.refetch().catch(() => {})
    a.api.posts.replace({ title: 'v2-after-mutation', likes: 0 })
    await Promise.resolve()
    await Promise.resolve()
    respond({ title: 'v1-stale', likes: 0 })
    await b.waitForIdle()
    expect(a.api.post.data.peek()).toEqual({ title: 'v2-after-mutation', likes: 0 })
    expect(b.api.post.data.peek()).toEqual({ title: 'v2-after-mutation', likes: 0 })
    a.dispose()
    b.dispose()
  })
})

describe('crossTabPlugin — message shapes', () => {
  const inject = (message: Record<string, unknown>) => {
    for (const l of buses.get('relay') ?? []) l({ data: message })
  }
  const base = (msgId: number) => ({
    v: PROTOCOL_VERSION,
    type: 'setData',
    sourceId: 'old-peer',
    msgId,
    queryId: 'relay/shapes',
    keyArgs: [],
  })

  test('a message without a source, as earlier versions send, is a write', async () => {
    const b = tab(postQuery('relay/shapes'), bus())
    await b.waitForIdle()
    inject({ ...base(1), data: { title: 'from an old tab', likes: 0 } })
    expect(b.api.post.data.peek()).toEqual({ title: 'from an old tab', likes: 0 })
    expect(b.api.post.hasPendingMutations.peek()).toBe(false)
    b.dispose()
  })

  test('an unknown source or a malformed server field is dropped with a warning', async () => {
    const warnings: string[] = []
    const b = createRoot(
      defineController((ctx) => ({ post: createQuery(ctx, postQuery('relay/shapes')) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [
          crossTabPlugin({
            channelName: 'relay',
            channelFactory: bus(),
            onWarn: (m) => warnings.push(m),
          }),
        ],
      },
    )
    await b.waitForIdle()
    inject({ ...base(1), source: 'teleport', data: { title: 'x', likes: 9 } })
    inject({ ...base(2), source: 'write', data: { title: 'x', likes: 9 }, server: 'nope' })
    inject({
      ...base(3),
      source: 'write',
      data: { title: 'x', likes: 9 },
      server: { data: {}, pageParams: 'nope' },
    })
    expect(b.api.post.data.peek()).toEqual({ title: 'Hello', likes: 0 })
    expect(warnings).toHaveLength(3)
    b.dispose()
  })
})
