import {
  createRoot,
  defineController,
  defineQuery,
  type Query,
  type QuerySubscription,
} from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChannelLike } from '../src/channel'
import { crossTabPlugin } from '../src/plugin'
import { type Message, PROTOCOL_VERSION } from '../src/protocol'

/**
 * Two-tab end-to-end coverage for `@kontsedal/olas-cross-tab`. SPEC §13.2.
 *
 * Strategy: a fake `BroadcastChannel` bus shared across two `QueryClient`s
 * — same channelName routes to the same bus.
 *
 * Module-graph caveat: in real life each tab is its own process with its
 * own `defineQuery` call, so `query.__clients` has only the local client.
 * In a single-process test, if both tabs share one `defineQuery` value,
 * `query.__clients` holds BOTH clients and `query.setData(...)` writes to
 * both synchronously — masking the cross-tab path. To preserve isolation,
 * each test mounts each "tab" with its OWN `defineQuery` value that
 * shares only the `queryId`. The registry's "last write wins" semantics
 * mean the most-recent definition routes inbound messages — that's fine
 * because every tab's `applyRemoteSetData` only applies if the LOCAL
 * `QueryClient` has an entry for the key, and each tab's local entries
 * are bound against its OWN query object.
 */

// ---- shared in-memory bus -------------------------------------------------

type Listener = (event: { data: unknown }) => void
type BusEntry = {
  listeners: Set<Listener>
  postCount: number
}

const buses = new Map<string, BusEntry>()

function getBus(name: string): BusEntry {
  let bus = buses.get(name)
  if (!bus) {
    bus = { listeners: new Set(), postCount: 0 }
    buses.set(name, bus)
  }
  return bus
}

function busChannelFactory(): (name: string) => ChannelLike {
  return (name: string) => {
    const bus = getBus(name)
    const localListeners = new Set<Listener>()
    return {
      postMessage(data) {
        bus.postCount += 1
        // Deliver only to OTHER channels' listeners — same-handle echo
        // would mimic a buggy transport, not the platform behaviour.
        for (const l of bus.listeners) {
          if (localListeners.has(l)) continue
          queueMicrotask(() => l({ data }))
        }
      },
      addEventListener(_type, listener) {
        bus.listeners.add(listener)
        localListeners.add(listener)
      },
      removeEventListener(_type, listener) {
        bus.listeners.delete(listener)
        localListeners.delete(listener)
      },
      close() {
        for (const l of localListeners) bus.listeners.delete(l)
        localListeners.clear()
      },
    }
  }
}

afterEach(() => {
  buses.clear()
})

// ---- builders that mint a fresh Query per tab -----------------------------

/**
 * Build a `defineQuery({ queryId, crossTab: true, ... })` value. Returns
 * the Query so each "tab" has its own module-scoped value (the registry
 * resolves the most-recent definition for routing, but each tab's local
 * entries are bound against its own value).
 *
 * The fetcher returns immediate `{ id, name: 'fetcher' }` so the initial
 * `ctx.use` doesn't leave entries in `pending` and confuse value reads.
 */
function makeUsersQuery(
  queryId: string,
  opts?: { crossTab?: boolean },
): Query<[string], { id: string; name: string }> {
  return defineQuery({
    queryId,
    crossTab: opts?.crossTab ?? true,
    key: (id: string) => ['user', id],
    fetcher: async (_ctx, id: string) => ({ id, name: 'fetcher' }),
    staleTime: 60_000, // suppress focus/reconnect refetch noise
  })
}

function mountTabs(opts: {
  queryA: Query<[string], { id: string; name: string }>
  queryB: Query<[string], { id: string; name: string }>
  channelNameA?: string
  channelNameB?: string
  onWarnA?: (msg: string, cause?: unknown) => void
  onWarnB?: (msg: string, cause?: unknown) => void
}) {
  const channelNameA = opts.channelNameA ?? 'test-channel'
  const channelNameB = opts.channelNameB ?? channelNameA
  const factory = busChannelFactory()

  const defA = defineController((ctx) => {
    const user = ctx.use(opts.queryA, () => ['1' as string])
    return { user } as { user: QuerySubscription<unknown> }
  })
  const defB = defineController((ctx) => {
    const user = ctx.use(opts.queryB, () => ['1' as string])
    return { user } as { user: QuerySubscription<unknown> }
  })

  const tabA = createRoot(defA, {
    deps: {},
    plugins: [
      crossTabPlugin({
        channelName: channelNameA,
        channelFactory: factory,
        onWarn: opts.onWarnA,
      }),
    ],
  })
  const tabB = createRoot(defB, {
    deps: {},
    plugins: [
      crossTabPlugin({
        channelName: channelNameB,
        channelFactory: factory,
        onWarn: opts.onWarnB,
      }),
    ],
  })

  return { tabA, tabB, postCount: () => getBus(channelNameA).postCount }
}

const flush = () => new Promise<void>((r) => queueMicrotask(r))
/** Drain microtask queue several times for async fetches to settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush()
}

// ---- tests ---------------------------------------------------------------

describe('crossTabPlugin', () => {
  test('1. setData in tab A is reflected in tab B', async () => {
    const queryA = makeUsersQuery('xtab-test/1')
    const queryB = makeUsersQuery('xtab-test/1')
    const tabs = mountTabs({ queryA, queryB })
    await settle()

    queryA.setData('1', () => ({ id: '1', name: 'Alice' }))
    await settle()

    type Sub = { user: { data: { peek(): unknown } } }
    expect((tabs.tabA as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'Alice' })
    expect((tabs.tabB as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'Alice' })

    tabs.tabA.dispose()
    tabs.tabB.dispose()
  })

  test('2. no echo — sender does not re-broadcast inbound writes', async () => {
    const queryA = makeUsersQuery('xtab-test/2')
    const queryB = makeUsersQuery('xtab-test/2')
    const tabs = mountTabs({ queryA, queryB })
    await settle()

    queryA.setData('1', () => ({ id: '1', name: 'X' }))
    await settle()

    // tabA broadcast once. tabB applied as remote (isRemote: true → no
    // outbound). Total postCount: 1.
    expect(tabs.postCount()).toBe(1)
    tabs.tabA.dispose()
    tabs.tabB.dispose()
  })

  test('3. crossTab: false queries stay isolated', async () => {
    const queryA = makeUsersQuery('xtab-test/3', { crossTab: false })
    const queryB = makeUsersQuery('xtab-test/3', { crossTab: false })
    const tabs = mountTabs({ queryA, queryB, channelNameA: 'iso', channelNameB: 'iso' })
    await settle()

    queryA.setData('1', () => ({ id: '1', name: 'A-only' }))
    await settle()

    type Sub = { user: { data: { peek(): unknown } } }
    expect((tabs.tabA as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'A-only' })
    // queryB.__clients only has tabB, queryA.setData('1', ...) wrote to
    // queryA.__clients (only tabA) — tabB is untouched. No outbound msg.
    expect((tabs.tabB as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'fetcher' })
    expect(getBus('iso').postCount).toBe(0)

    tabs.tabA.dispose()
    tabs.tabB.dispose()
  })

  test('4. crossTab: true without queryId warns and is skipped at core level', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Build a query without a queryId.
    const noIdQuery = defineQuery({
      crossTab: true,
      key: (id: string) => ['noid', id],
      fetcher: async (_ctx, id: string) => ({ id }),
      staleTime: 60_000,
    })

    const factory = busChannelFactory()
    const def = defineController((ctx) => {
      const u = ctx.use(noIdQuery, () => ['1' as string])
      return { user: u }
    })
    const a = createRoot(def, {
      deps: {},
      plugins: [crossTabPlugin({ channelName: 'noid-chan', channelFactory: factory })],
    })
    await settle()

    noIdQuery.setData('1', () => ({ id: 'tab-a' }))
    await settle()

    // No queryId → core skips firing onSetData → plugin never broadcasts.
    expect(getBus('noid-chan').postCount).toBe(0)
    // Dev-warning fired (from defineQuery's queryId check).
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('requires a stable `queryId`'),
      ),
    ).toBe(true)

    warnSpy.mockRestore()
    a.dispose()
  })

  test('5. invalidation propagates → receiving tab refetches', async () => {
    const queryA = makeUsersQuery('xtab-test/5')
    const queryB = makeUsersQuery('xtab-test/5')
    const tabs = mountTabs({ queryA, queryB })
    await settle()

    // setData overwrites the fetcher result on both tabs (queryA's
    // setData broadcasts; queryB applies remotely).
    queryA.setData('1', () => ({ id: '1', name: 'pre' }))
    await settle()

    type Sub = { user: { data: { peek(): unknown } } }
    expect((tabs.tabB as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'pre' })

    // Invalidate via tabA. Tab B applies the invalidation remotely and
    // refetches (fetcher returns `{ id: '1', name: 'fetcher' }`).
    queryA.invalidate('1')
    await settle()
    expect((tabs.tabB as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'fetcher' })

    tabs.tabA.dispose()
    tabs.tabB.dispose()
  })

  test('6. non-cloneable data triggers onWarn; sender cache unaffected', async () => {
    const onWarnA = vi.fn()
    const queryA = makeUsersQuery('xtab-test/6')
    const queryB = makeUsersQuery('xtab-test/6')
    // Wrap the factory with a structured-clone check that throws on
    // function payloads.
    const baseFactory = busChannelFactory()
    const factory = (name: string): ChannelLike => {
      const ch = baseFactory(name)
      return {
        ...ch,
        postMessage(data) {
          check(data)
          ch.postMessage(data)
        },
      }
    }
    function check(v: unknown) {
      if (typeof v === 'function') throw new Error('DataCloneError')
      if (v && typeof v === 'object')
        for (const x of Object.values(v as Record<string, unknown>)) check(x)
    }

    const defA = defineController((ctx) => {
      const u = ctx.use(queryA, () => ['1' as string])
      return { user: u }
    })
    const defB = defineController((ctx) => {
      const u = ctx.use(queryB, () => ['1' as string])
      return { user: u }
    })
    const tabA = createRoot(defA, {
      deps: {},
      plugins: [
        crossTabPlugin({
          channelName: 'nc-chan',
          channelFactory: factory,
          onWarn: onWarnA,
        }),
      ],
    })
    const tabB = createRoot(defB, {
      deps: {},
      plugins: [crossTabPlugin({ channelName: 'nc-chan', channelFactory: factory })],
    })
    await settle()

    type Sub = { user: { data: { peek(): { id: string; name?: string } | undefined } } }
    // Payload includes a non-cloneable function — the cast hides it from
    // the QuerySpec's structural typing.
    const payload = { id: '1', name: 'with-fn', cb: () => 'nope' } as unknown as {
      id: string
      name: string
    }
    queryA.setData('1', () => payload)
    await settle()

    // Sender cache: write succeeded locally (the setData ran BEFORE the
    // broadcast; the throw on postMessage is caught + warned).
    expect((tabA as unknown as Sub).user.data.peek()?.name).toBe('with-fn')
    // Receiver: never got a message (postMessage threw and was caught).
    expect((tabB as unknown as Sub).user.data.peek()?.name).toBe('fetcher')
    expect(onWarnA).toHaveBeenCalled()
    expect(onWarnA.mock.calls[0]![0]).toContain('not structured-cloneable')

    tabA.dispose()
    tabB.dispose()
  })

  test('7. SSR — channelFactory returning undefined yields a no-op plugin', () => {
    const def = defineController(() => ({}))
    expect(() =>
      createRoot(def, {
        deps: {},
        plugins: [crossTabPlugin({ channelName: 'unused', channelFactory: () => undefined })],
      }).dispose(),
    ).not.toThrow()
  })

  test('8. dispose closes the channel + removes the listener', async () => {
    const queryA = makeUsersQuery('xtab-test/8')
    const queryB = makeUsersQuery('xtab-test/8')
    const factory = busChannelFactory()
    const defA = defineController((ctx) => {
      const u = ctx.use(queryA, () => ['1' as string])
      return { user: u }
    })
    const defB = defineController((ctx) => {
      const u = ctx.use(queryB, () => ['1' as string])
      return { user: u }
    })
    const a = createRoot(defA, {
      deps: {},
      plugins: [crossTabPlugin({ channelName: 'dispose-test', channelFactory: factory })],
    })
    const b = createRoot(defB, {
      deps: {},
      plugins: [crossTabPlugin({ channelName: 'dispose-test', channelFactory: factory })],
    })
    await settle()

    expect(getBus('dispose-test').listeners.size).toBe(2)
    a.dispose()
    expect(getBus('dispose-test').listeners.size).toBe(1)

    // Tab B still works.
    queryB.setData('1', () => ({ id: '1', name: 'after-a-gone' }))
    await settle()
    type Sub = { user: { data: { peek(): unknown } } }
    expect((b as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'after-a-gone' })

    b.dispose()
  })

  test('9. different channelName isolation', async () => {
    const queryA = makeUsersQuery('xtab-test/9')
    const queryB = makeUsersQuery('xtab-test/9')
    const tabs = mountTabs({
      queryA,
      queryB,
      channelNameA: 'chan-a',
      channelNameB: 'chan-b',
    })
    await settle()

    queryA.setData('1', () => ({ id: '1', name: 'A-only' }))
    await settle()

    type Sub = { user: { data: { peek(): unknown } } }
    expect((tabs.tabA as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'A-only' })
    expect((tabs.tabB as unknown as Sub).user.data.peek()).toEqual({ id: '1', name: 'fetcher' })

    tabs.tabA.dispose()
    tabs.tabB.dispose()
  })

  test('10. out-of-order / duplicate messages are deduped', async () => {
    // Plug in a one-tab harness so we can hand-deliver messages. Wrap
    // the listener in a `{ ref }` cell so TS doesn't narrow it to the
    // initial null at the call sites.
    const listenerRef: { current: ((event: { data: unknown }) => void) | null } = {
      current: null,
    }
    const factory = (_name: string): ChannelLike => ({
      postMessage() {},
      addEventListener(_type, listener) {
        listenerRef.current = listener
      },
      removeEventListener() {
        listenerRef.current = null
      },
      close() {
        listenerRef.current = null
      },
    })

    const queryA = makeUsersQuery('xtab-test/10')
    const def = defineController((ctx) => {
      const u = ctx.use(queryA, () => ['1' as string])
      return { user: u }
    })
    const root = createRoot(def, {
      deps: {},
      plugins: [crossTabPlugin({ channelName: 'dedup', channelFactory: factory })],
    })
    await settle()

    // Need a local entry to apply to — the initial fetch creates one.
    type Sub = { user: { data: { peek(): unknown } } }
    const peek = () => (root as unknown as Sub).user.data.peek()

    const peer = 'remote-peer-1'
    const mk = (msgId: number, name: string): Message => ({
      v: PROTOCOL_VERSION,
      type: 'setData',
      sourceId: peer,
      msgId,
      queryId: 'xtab-test/10',
      keyArgs: ['user', '1'],
      data: { id: '1', name },
    })

    // Out-of-order delivery: msgId 5 first, then msgId 3.
    listenerRef.current?.({ data: mk(5, 'high-5') })
    expect(peek()).toEqual({ id: '1', name: 'high-5' })
    listenerRef.current?.({ data: mk(3, 'low-3') })
    expect(peek()).toEqual({ id: '1', name: 'high-5' })

    // Exact duplicate.
    listenerRef.current?.({ data: mk(5, 'duplicate-5') })
    expect(peek()).toEqual({ id: '1', name: 'high-5' })

    // Next-higher msgId is accepted.
    listenerRef.current?.({ data: mk(6, 'higher-6') })
    expect(peek()).toEqual({ id: '1', name: 'higher-6' })

    // Wrong protocol version is dropped silently.
    const wrongV = { ...mk(7, 'wrong-v'), v: 99 }
    listenerRef.current?.({ data: wrongV })
    expect(peek()).toEqual({ id: '1', name: 'higher-6' })

    root.dispose()
  })

  test('11. plugin instance reused across two roots surfaces an onError', () => {
    // Per `ASSESSMENT.md`: a single `crossTabPlugin({...})` instance owns
    // one sourceId / channel / listener Map. Sharing across two roots would
    // clobber state on the second init — the guard throws from `init`. The
    // QueryClient routes that throw through `onError({ kind: 'plugin' })`
    // (it doesn't tear down the root), but the misuse is now visible.
    const factory = busChannelFactory()
    const plugin = crossTabPlugin({ channelName: 'reuse', channelFactory: factory })

    const q = makeUsersQuery('xtab-test/11')
    const def = defineController((ctx) => ({ user: ctx.use(q, () => ['1' as string]) }))

    const onError1 = vi.fn()
    const root1 = createRoot(def, { deps: {}, plugins: [plugin], onError: onError1 })
    // First root: clean — no plugin error.
    expect(onError1).not.toHaveBeenCalled()

    const onError2 = vi.fn()
    const root2 = createRoot(def, { deps: {}, plugins: [plugin], onError: onError2 })
    // Second root: plugin init throws → dispatched as kind:'plugin'.
    const pluginErr = onError2.mock.calls.find((c) => (c[1] as { kind: string }).kind === 'plugin')
    expect(pluginErr).toBeTruthy()
    expect((pluginErr?.[0] as Error).message).toMatch(/reused across multiple roots/)

    root1.dispose()
    root2.dispose()
  })
})
