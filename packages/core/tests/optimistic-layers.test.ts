/**
 * What a canonical write and a commit do to the optimistic layers still live
 * under them (SPEC §6.4). A rollback restores server truth, and server truth
 * includes every canonical write and every committed layer.
 *
 * - A canonical `write` is a patch, so it patches each live layer's baseline
 *   with its own updater. Setting every baseline to the visible data made the
 *   guess on screen permanent: a rollback restored it.
 * - A committed (`finalize`d) layer is server truth now, so it is folded into
 *   the baselines of the layers still live below it by re-running its updater
 *   there. A lower layer that failed later restored a baseline from before the
 *   commit, and the committed change was lost.
 */
import { describe, expect, test } from 'vitest'
import { bindQuery, createCache, createMutation, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { definePlugin } from '../src/plugin/host'
import type { OlasPlugin, PluginHost, WriteEvent } from '../src/plugin/types'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

type Post = { likes: number; liked: boolean; title: string }

/** A post query whose server answers with `server.post`, and a root subscribed to it. */
function postRoot(plugins: OlasPlugin[] = []) {
  const server = { post: { likes: 0, liked: false, title: 'a' } as Post, fetches: 0 }
  const post = defineQuery({
    id: `optimistic-layers/post/${Math.random()}`,
    key: () => ['post'],
    fetcher: async () => {
      server.fetches += 1
      return { ...server.post }
    },
    staleTime: 60_000,
  })
  const root = createRoot(
    defineController((ctx) => ({ post: createQuery(ctx, post) })),
    { queries: queryEngine(), deps: {}, plugins },
  )
  return { server, post, root, handle: root.bindQuery(post) }
}

const like = (p: Post | undefined): Post => ({ ...(p as Post), likes: p!.likes + 1, liked: true })

describe('a canonical write patches each live baseline', () => {
  // The reviewer's reproduction, through a real mutation that fails.
  test('a pushed title survives a failed like', async () => {
    let fail: (err: Error) => void = () => {}
    const post = defineQuery({
      id: 'optimistic-layers/like-mutation',
      key: () => ['post'],
      fetcher: async (): Promise<Post> => ({ likes: 0, liked: false, title: 'a' }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => {
        const handle = bindQuery(ctx, post)
        return {
          post: createQuery(ctx, post),
          handle,
          like: createMutation(ctx, {
            mutate: () =>
              new Promise<void>((_, reject) => {
                fail = reject
              }),
            onMutate: () => handle.setData(like),
          }),
        }
      }),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    const run = root.api.like.run(undefined).catch(() => {})
    expect(root.api.post.data.value).toEqual({ likes: 1, liked: true, title: 'a' })

    root.api.handle.write((p) => ({ ...(p as Post), title: 'b' }))
    expect(root.api.post.data.value).toEqual({ likes: 1, liked: true, title: 'b' })

    fail(new Error('like rejected'))
    await run
    expect(root.api.post.data.value).toEqual({ likes: 0, liked: false, title: 'b' })
    root.dispose()
  })

  test('two live layers each keep their own baseline, patched', async () => {
    const { root, handle } = postRoot()
    await root.waitForIdle()
    const a = handle.setData(like)
    const b = handle.setData((p) => ({ ...(p as Post), title: 'guess' }))
    handle.write((p) => ({ ...(p as Post), likes: p!.likes + 10 }))
    expect(root.api.post.data.value).toEqual({ likes: 11, liked: true, title: 'guess' })

    b.rollback()
    // A's layer, over the patched server value.
    expect(root.api.post.data.value).toEqual({ likes: 11, liked: true, title: 'a' })
    a.rollback()
    expect(root.api.post.data.value).toEqual({ likes: 10, liked: false, title: 'a' })
    root.dispose()
  })

  test('a whole-value replace still becomes every baseline', async () => {
    const { root, handle } = postRoot()
    await root.waitForIdle()
    const a = handle.setData(like)
    handle.replace({ likes: 5, liked: false, title: 'r' })
    a.rollback()
    expect(root.api.post.data.value).toEqual({ likes: 5, liked: false, title: 'r' })
    root.dispose()
  })

  test("a plugin's host write patches the baselines too", async () => {
    let host: PluginHost | undefined
    const grab = definePlugin({
      name: 'grab',
      setup(h) {
        host = h
      },
    })
    const { root, handle, post } = postRoot([grab])
    await root.waitForIdle()
    const a = handle.setData(like)
    const id = (post as unknown as { __id: string }).__id
    host?.queries?.write(id, ['post'], (p) => ({ ...(p as Post), title: 'pushed' }))
    a.rollback()
    expect(root.api.post.data.value).toEqual({ likes: 0, liked: false, title: 'pushed' })
    root.dispose()
  })

  test('a local cache write patches the baselines too', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        post: createCache(ctx, async (): Promise<Post> => ({ likes: 0, liked: false, title: 'a' })),
      })),
      { deps: {} },
    )
    await root.waitForIdle()
    const a = root.api.post.setData(like)
    root.api.post.write((p) => ({ ...(p as Post), title: 'b' }))
    a.rollback()
    expect(root.api.post.data.value).toEqual({ likes: 0, liked: false, title: 'b' })
    root.dispose()
  })

  test('an updater that throws on a baseline makes the entry refetch once the layers settle', async () => {
    let fetches = 0
    let release: (p: Post) => void = () => {}
    const empty = defineQuery({
      id: 'optimistic-layers/throwing-patch',
      key: () => ['e'],
      fetcher: () => {
        fetches += 1
        if (fetches === 1) {
          return new Promise<Post>((resolve) => {
            release = resolve
          })
        }
        return Promise.resolve({ likes: 7, liked: false, title: 'server' })
      },
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ e: createQuery(ctx, empty) })),
      { queries: queryEngine(), deps: {} },
    )
    const e = root.bindQuery(empty)
    // The recipe on an entry with no data yet: the layer's baseline is `undefined`.
    e.cancel()
    release({ likes: 0, liked: false, title: 'late' })
    const guess = e.setData(() => ({ likes: 1, liked: true, title: 'guess' }))
    // The patch reads `p.title`, so it throws on the `undefined` baseline.
    e.write((p) => ({ ...(p as Post), title: `${p!.title}!` }))
    expect(root.api.e.data.value).toEqual({ likes: 1, liked: true, title: 'guess!' })
    guess.rollback()
    await flush()
    // The baseline could not be patched, so the known-wrong value does not stand.
    expect(fetches).toBe(2)
    expect(root.api.e.data.value).toEqual({ likes: 7, liked: false, title: 'server' })
    root.dispose()
  })
})

type Flags = { a: boolean; b: boolean }

function flagsRoot() {
  const server = { flags: { a: false, b: false } as Flags, fetches: 0 }
  const flags = defineQuery({
    id: `optimistic-layers/flags/${Math.random()}`,
    key: () => ['flags'],
    fetcher: async () => {
      server.fetches += 1
      return { ...server.flags }
    },
    staleTime: 60_000,
  })
  const root = createRoot(
    defineController((ctx) => ({ flags: createQuery(ctx, flags) })),
    { queries: queryEngine(), deps: {} },
  )
  return { server, root, handle: root.bindQuery(flags) }
}

const toggleA = (f: Flags | undefined): Flags => ({ ...(f as Flags), a: !f!.a })
const toggleB = (f: Flags | undefined): Flags => ({ ...(f as Flags), b: !f!.b })

describe('a committed layer folds into the baselines below it', () => {
  // The reviewer's reproduction: two parallel toggles, the newer one commits.
  test('the newer layer commits, the older one fails: the commit stays', async () => {
    const { root, handle } = flagsRoot()
    await root.waitForIdle()
    const a = handle.setData(toggleA)
    const b = handle.setData(toggleB)
    expect(root.api.flags.data.value).toEqual({ a: true, b: true })
    b.finalize()
    a.rollback()
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    expect(root.api.flags.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('through two parallel mutations', async () => {
    const settle: Record<string, { ok: () => void; fail: () => void }> = {}
    const flags = defineQuery({
      id: 'optimistic-layers/toggle-mutations',
      key: () => ['flags'],
      fetcher: async (): Promise<Flags> => ({ a: false, b: false }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => {
        const handle = bindQuery(ctx, flags)
        return {
          flags: createQuery(ctx, flags),
          toggle: createMutation(ctx, {
            mutate: (which: 'a' | 'b') =>
              new Promise<void>((resolve, reject) => {
                settle[which] = { ok: resolve, fail: () => reject(new Error(which)) }
              }),
            onMutate: (which) => handle.setData(which === 'a' ? toggleA : toggleB),
          }),
        }
      }),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    const ra = root.api.toggle.run('a').catch(() => {})
    const rb = root.api.toggle.run('b')
    settle.b?.ok()
    await rb
    settle.a?.fail()
    await ra
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('three layers, the middle one commits: each lower rollback keeps it', async () => {
    const { root, handle } = flagsRoot()
    await root.waitForIdle()
    const a = handle.setData(toggleA)
    const b = handle.setData(toggleB)
    const c = handle.setData((f) => ({ ...(f as Flags), a: false }))
    b.finalize()
    c.rollback()
    expect(root.api.flags.data.value).toEqual({ a: true, b: true })
    a.rollback()
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('a non-top rollback after a commit threads the committed baseline up', async () => {
    const { root, handle } = flagsRoot()
    await root.waitForIdle()
    const a = handle.setData(toggleA)
    const b = handle.setData(toggleB)
    const c = handle.setData((f) => ({ ...(f as Flags), a: false }))
    b.finalize()
    a.rollback()
    // C is still live on top, so the screen keeps its value.
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    c.rollback()
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('a layer pushed after a fetch landed folds into the rebased baseline', async () => {
    const { server, root, handle } = flagsRoot()
    await root.waitForIdle()
    const a = handle.setData(toggleA)
    server.flags = { a: false, b: false }
    await handle.invalidate()
    const b = handle.setData(toggleB)
    b.finalize()
    a.rollback()
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('a layer live across a fetch does not fold again: the fetched truth stands', async () => {
    const { server, root, handle } = flagsRoot()
    await root.waitForIdle()
    const a = handle.setData(toggleA)
    const b = handle.setData(toggleB)
    // The server already applied B when this read ran.
    server.flags = { a: false, b: true }
    await handle.invalidate()
    b.finalize()
    a.rollback()
    // Re-running B's toggle over the fetched value would flip `b` back.
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('an updater that throws on a lower baseline makes the entry refetch', async () => {
    const { server, root, handle } = flagsRoot()
    await root.waitForIdle()
    const a = handle.setData(() => ({ a: true, b: false }))
    const b = handle.setData((f) => {
      if (!f!.a) throw new Error('B only applies over A')
      return { ...(f as Flags), b: true }
    })
    server.flags = { a: false, b: true }
    const before = server.fetches
    b.finalize()
    a.rollback()
    await flush()
    expect(server.fetches).toBe(before + 1)
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })
})

type Page = { items: string[]; n: number }

function feedRoot() {
  const feed = defineInfiniteQuery({
    id: `optimistic-layers/feed/${Math.random()}`,
    key: () => ['feed'],
    fetcher: async ({ pageParam }: { pageParam: number }): Promise<Page> => ({
      items: [`p${pageParam}`],
      n: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (last: Page) => (last.n < 3 ? last.n + 1 : null),
    staleTime: 60_000,
  })
  const root = createRoot(
    defineController((ctx) => ({ feed: createQuery(ctx, feed) })),
    { queries: queryEngine(), deps: {} },
  )
  return { root, handle: root.bindQuery(feed) }
}

const prependTo = (item: string) => (pages: Page[] | undefined) => {
  const [first, ...rest] = pages ?? []
  return [{ ...(first as Page), items: [item, ...(first as Page).items] }, ...rest]
}

describe('infinite queries follow the same two rules', () => {
  test('a canonical page patch survives a failed optimistic insert', async () => {
    const { root, handle } = feedRoot()
    await root.waitForIdle()
    const a = handle.setData(prependTo('guess'))
    handle.write(prependTo('pushed'))
    expect(root.api.feed.pages.value[0]?.items).toEqual(['pushed', 'guess', 'p0'])
    a.rollback()
    expect(root.api.feed.pages.value[0]?.items).toEqual(['pushed', 'p0'])
    root.dispose()
  })

  test('a committed insert survives an older layer that fails', async () => {
    const { root, handle } = feedRoot()
    await root.waitForIdle()
    const a = handle.setData(prependTo('a'))
    const b = handle.setData(prependTo('b'))
    b.finalize()
    a.rollback()
    expect(root.api.feed.pages.value[0]?.items).toEqual(['b', 'p0'])
    expect(root.dehydrate().entries[0]?.pageParams).toEqual([0])
    root.dispose()
  })

  test('a page patch that throws on a baseline makes the entry refetch once the layers settle', async () => {
    let fetches = 0
    const feed = defineInfiniteQuery({
      id: 'optimistic-layers/feed-throwing-patch',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }): Promise<Page> => {
        fetches += 1
        return { items: [`p${pageParam}`], n: pageParam }
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    const handle = root.bindQuery(feed)
    const a = handle.setData(prependTo('guess'))
    // The patch only fits the guessed pages.
    handle.write((pages) => {
      if (pages?.[0]?.items[0] !== 'guess') throw new Error('no guess here')
      return pages
    })
    a.rollback()
    await flush()
    expect(fetches).toBe(2)
    root.dispose()
  })

  test('a committed layer that adds a page keeps the params aligned', async () => {
    const { root, handle } = feedRoot()
    await root.waitForIdle()
    const a = handle.setData(prependTo('a'))
    const b = handle.setData((pages) => [...(pages ?? []), { items: ['extra'], n: 9 }])
    b.finalize()
    a.rollback()
    expect(root.api.feed.pages.value.map((p) => p.items)).toEqual([['p0'], ['extra']])
    expect(root.dehydrate().entries[0]?.pageParams).toHaveLength(2)
    root.dispose()
  })
})

// A rollback of a layer that was not the top left the data on screen alone,
// so the failed guess stayed while a layer above it was live, and a commit of
// that layer then reported it as committed truth. The layers above a removed
// one are now replayed over the baseline it restored (SPEC §6.4).
describe('an out-of-order rollback leaves no guess behind', () => {
  /** A flags root with a plugin that records every write. */
  function recordedFlagsRoot() {
    const writes: WriteEvent[] = []
    const recorder = definePlugin({
      name: 'recorder',
      setup: () => ({ onWrite: (e) => writes.push(e) }),
    })
    const server = { flags: { a: false, b: false } as Flags, fetches: 0 }
    const flags = defineQuery({
      id: `optimistic-layers/replay/${Math.random()}`,
      key: () => ['flags'],
      fetcher: async () => {
        server.fetches += 1
        return { ...server.flags }
      },
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ flags: createQuery(ctx, flags) })),
      { queries: queryEngine(), deps: {}, plugins: [recorder] },
    )
    return { writes, server, root, handle: root.bindQuery(flags) }
  }

  // The phase-2 reproduction.
  test('A rolls back under B, then B commits: the commit carries B alone', async () => {
    const { writes, root, handle } = recordedFlagsRoot()
    await root.waitForIdle()
    writes.length = 0
    const a = handle.setData(toggleA)
    const b = handle.setData(toggleB)
    a.rollback()
    // A's guess leaves the screen at once, and plugins hear the corrected value.
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    expect(writes.at(-1)).toMatchObject({ source: 'rollback', data: { a: false, b: true } })
    b.finalize()
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    expect(writes.at(-1)).toMatchObject({
      source: 'commit',
      data: { a: false, b: true },
      server: { data: { a: false, b: true } },
    })
    root.dispose()
  })

  test('through two parallel mutations, the older failing first', async () => {
    const settle: Record<string, { ok: () => void; fail: () => void }> = {}
    const flags = defineQuery({
      id: 'optimistic-layers/replay-mutations',
      key: () => ['flags'],
      fetcher: async (): Promise<Flags> => ({ a: false, b: false }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => {
        const handle = bindQuery(ctx, flags)
        return {
          flags: createQuery(ctx, flags),
          toggle: createMutation(ctx, {
            mutate: (which: 'a' | 'b') =>
              new Promise<void>((resolve, reject) => {
                settle[which] = { ok: resolve, fail: () => reject(new Error(which)) }
              }),
            onMutate: (which) => handle.setData(which === 'a' ? toggleA : toggleB),
          }),
        }
      }),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    const ra = root.api.toggle.run('a').catch(() => {})
    const rb = root.api.toggle.run('b')
    settle.a?.fail()
    await ra
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    settle.b?.ok()
    await rb
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('every layer above the removed one is replayed, not only the next', async () => {
    const { root, handle } = recordedFlagsRoot()
    await root.waitForIdle()
    const setC = (f: Flags | undefined): Flags => ({ ...(f as Flags), c: true }) as Flags
    const setD = (f: Flags | undefined): Flags => ({ ...(f as Flags), d: true }) as Flags
    const a = handle.setData(toggleA)
    const b = handle.setData(toggleB)
    const c = handle.setData(setC)
    const d = handle.setData(setD)
    b.rollback()
    expect(root.api.flags.data.value).toEqual({ a: true, b: false, c: true, d: true })
    d.rollback()
    // D's baseline no longer holds B's guess.
    expect(root.api.flags.data.value).toEqual({ a: true, b: false, c: true })
    c.finalize()
    a.rollback()
    expect(root.api.flags.data.value).toEqual({ a: false, b: false, c: true })
    root.dispose()
  })

  test('a layer a fetch has since replaced is not replayed', async () => {
    const { server, root, handle } = recordedFlagsRoot()
    await root.waitForIdle()
    const a = handle.setData(toggleA)
    handle.setData(toggleB)
    // The server already applied B when this read ran.
    server.flags = { a: false, b: true }
    await handle.invalidate()
    a.rollback()
    // Re-running B's toggle over the fetched value would flip `b` back.
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('a plain value above cannot drop the guess it captured: the entry refetches', async () => {
    const { server, root, handle } = recordedFlagsRoot()
    await root.waitForIdle()
    const a = handle.setData(toggleA)
    // A whole value, taken from the screen while A's guess was on it.
    const shown = root.api.flags.data.value as Flags
    const p = handle.setData(() => ({ ...shown, b: true }))
    a.rollback()
    expect(root.api.flags.data.value).toEqual({ a: true, b: true })
    server.flags = { a: false, b: true }
    const before = server.fetches
    p.finalize()
    await flush()
    expect(server.fetches).toBe(before + 1)
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('an updater that throws on replay leaves the screen and makes the entry refetch', async () => {
    const { server, root, handle } = recordedFlagsRoot()
    await root.waitForIdle()
    const a = handle.setData(() => ({ a: true, b: false }))
    const b = handle.setData((f) => {
      if (!f!.a) throw new Error('B only applies over A')
      return { ...(f as Flags), b: true }
    })
    a.rollback()
    expect(root.api.flags.data.value).toEqual({ a: true, b: true })
    server.flags = { a: false, b: true }
    const before = server.fetches
    b.finalize()
    await flush()
    expect(server.fetches).toBe(before + 1)
    expect(root.api.flags.data.value).toEqual({ a: false, b: true })
    root.dispose()
  })

  test('infinite: the pages lose the failed layer, and the commit reports what is left', async () => {
    const writes: WriteEvent[] = []
    const recorder = definePlugin({
      name: 'recorder',
      setup: () => ({ onWrite: (e) => writes.push(e) }),
    })
    const feed = defineInfiniteQuery({
      id: 'optimistic-layers/replay-feed',
      key: () => ['feed'],
      fetcher: async ({ pageParam }: { pageParam: number }): Promise<Page> => ({
        items: [`p${pageParam}`],
        n: pageParam,
      }),
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {}, plugins: [recorder] },
    )
    await root.waitForIdle()
    const handle = root.bindQuery(feed)
    const a = handle.setData(prependTo('a'))
    const b = handle.setData(prependTo('b'))
    a.rollback()
    expect(root.api.feed.pages.value[0]?.items).toEqual(['b', 'p0'])
    b.finalize()
    expect(root.api.feed.pages.value[0]?.items).toEqual(['b', 'p0'])
    expect(writes.at(-1)).toMatchObject({ source: 'commit', pageParams: [0] })
    const committed = writes.at(-1)?.data as Page[] | undefined
    expect(committed?.[0]?.items).toEqual(['b', 'p0'])
    root.dispose()
  })
})
