import {
  type GcEvent,
  type InvalidateEvent,
  lookupRegisteredQuery,
  type QueryClientPlugin,
  type QueryClientPluginApi,
  type SetDataEvent,
} from '@kontsedal/olas-core'
import { type ChannelLike, defaultChannelFactory } from './channel'
import { type Message, PROTOCOL_VERSION } from './protocol'

/**
 * Options accepted by `crossTabPlugin(...)`. SPEC §13.2.
 *
 * - `channelName` — name of the `BroadcastChannel`. Required. Users who
 *   want clean cross-deploy isolation should include a version suffix
 *   (e.g. `'my-app/cache/v2'`).
 * - `onWarn` — called for non-fatal conditions: a `DataCloneError` while
 *   posting (the data isn't structured-cloneable), or a malformed
 *   inbound message. Default: `console.warn`.
 * - `channelFactory` — override the channel constructor. Mainly for
 *   tests that share an in-memory bus across two QueryClients.
 */
export type CrossTabOptions = {
  channelName: string
  onWarn?: (message: string, cause?: unknown) => void
  channelFactory?: (name: string) => ChannelLike | undefined
}

/**
 * Generate a unique-enough source id for a plugin instance. Combines
 * `Date.now()` with `Math.random()` — collisions across same-millisecond
 * tab-opens are negligible at one-decimal-place randomness, and even a
 * collision only loses dedup, not correctness.
 */
function makeSourceId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}-${rand}`
}

const NOOP_PLUGIN: QueryClientPlugin = {}

/**
 * Cross-tab cache sync over `BroadcastChannel`. Mirrors `setData` /
 * `invalidate` writes across tabs of the same origin.
 *
 * Wire it up via `RootOptions.plugins`:
 *
 * ```ts
 * createRoot(appController, {
 *   deps,
 *   plugins: [crossTabPlugin({ channelName: 'my-app/cache/v1' })],
 * })
 * ```
 *
 * Queries must opt in via `defineQuery({ queryId: '<unique>', crossTab: true })`
 * — the `queryId` routes inbound messages back to the right query, and
 * `crossTab: true` is the per-query opt-in (queries that don't set it are
 * ignored by the sender so module-internal queries don't leak).
 *
 * **SSR safety.** When `BroadcastChannel` is not defined (Node, older
 * browsers without the feature) and no `channelFactory` override is
 * supplied, the function returns a no-op plugin object. The root still
 * boots cleanly; cross-tab is just disabled.
 *
 * **Non-cloneable data.** `BroadcastChannel` uses structured clone. Cache
 * data containing functions, class instances, or symbols throws a
 * `DataCloneError` at `postMessage`. The plugin catches the throw, calls
 * `onWarn(...)`, and drops the message — the sender's cache is unaffected.
 */
export function crossTabPlugin(options: CrossTabOptions): QueryClientPlugin {
  const channelName = options.channelName
  const onWarn = options.onWarn ?? defaultWarn
  const factory = options.channelFactory ?? defaultChannelFactory

  // Cheap probe — if the environment can't produce a channel at all we can
  // return a no-op plugin without opening anything. The real channel opens
  // lazily in `init` so a plugin that's constructed but never passed to a
  // root doesn't leak a BroadcastChannel.
  const probe = factory(channelName)
  if (!probe) {
    // SSR / unsupported environment. Caller's plugin slot still receives a
    // valid plugin object; it just does nothing.
    return NOOP_PLUGIN
  }
  probe.close()

  const sourceId = makeSourceId()
  let msgIdCounter = 0
  const seenByPeer = new Map<string, number>()
  let api: QueryClientPluginApi | null = null
  let channel: ChannelLike | null = null

  const listener = (event: { data: unknown }) => {
    const msg = event.data as Partial<Message> | null
    if (!msg || typeof msg !== 'object') return
    // Layer 1 — protocol version drop.
    if (msg.v !== PROTOCOL_VERSION) return
    // Layer 2 — own-source drop (transport echoed our own message back).
    if (msg.sourceId === sourceId) return
    // Layer 3 — out-of-order / duplicate drop.
    if (typeof msg.sourceId !== 'string' || typeof msg.msgId !== 'number') return
    const last = seenByPeer.get(msg.sourceId) ?? -1
    if (msg.msgId <= last) return
    seenByPeer.set(msg.sourceId, msg.msgId)

    if (msg.type === 'setData') {
      if (typeof msg.queryId !== 'string' || !Array.isArray(msg.keyArgs)) {
        onWarn('[olas/cross-tab] malformed setData message')
        return
      }
      api?.applyRemoteSetData(msg.queryId, msg.keyArgs, msg.data)
      return
    }
    if (msg.type === 'invalidate') {
      if (typeof msg.queryId !== 'string' || !Array.isArray(msg.keyArgs)) {
        onWarn('[olas/cross-tab] malformed invalidate message')
        return
      }
      api?.applyRemoteInvalidate(msg.queryId, msg.keyArgs)
      return
    }
  }

  const send = (msg: Message): void => {
    if (channel === null) return
    try {
      channel.postMessage(msg)
    } catch (cause) {
      // Structured clone failed — most likely non-cloneable data on a
      // setData payload. Warn and drop.
      onWarn(
        `[olas/cross-tab] failed to broadcast ${msg.type} for queryId="${msg.queryId}": data is not structured-cloneable`,
        cause,
      )
    }
  }

  return {
    init(a) {
      api = a
      channel = factory(channelName) ?? null
      channel?.addEventListener('message', listener)
    },

    onSetData(event: SetDataEvent) {
      // Don't echo inbound writes — Layer-1 sender-side echo prevention.
      if (event.isRemote) return
      // Infinite queries are deferred for v1 — see SPEC §13.2.
      if (event.kind !== 'data') return
      if (!shouldBroadcast(event.queryId)) return

      send({
        v: PROTOCOL_VERSION,
        type: 'setData',
        sourceId,
        msgId: ++msgIdCounter,
        queryId: event.queryId,
        keyArgs: event.keyArgs,
        data: event.data,
      })
    },

    onInvalidate(event: InvalidateEvent) {
      if (event.isRemote) return
      if (event.kind !== 'data') return
      if (!shouldBroadcast(event.queryId)) return

      send({
        v: PROTOCOL_VERSION,
        type: 'invalidate',
        sourceId,
        msgId: ++msgIdCounter,
        queryId: event.queryId,
        keyArgs: event.keyArgs,
      })
    },

    onGc(_event: GcEvent) {
      // GC is local — we don't propagate it. Each tab gc's its own entries
      // when its own subscribers drop.
    },

    dispose() {
      if (channel !== null) {
        channel.removeEventListener('message', listener)
        channel.close()
        channel = null
      }
      api = null
    },
  }
}

function defaultWarn(message: string, cause?: unknown): void {
  if (cause !== undefined) {
    console.warn(message, cause)
  } else {
    console.warn(message)
  }
}

/**
 * Per-query gate. `crossTab: true` is a static opt-in on the spec; the
 * QueryClient doesn't filter on it (its events fire for every query that
 * has a `queryId`), so the plugin checks here. We look it up from the
 * core's query registry on every event — no caching, since the registry
 * lookup is a Map.get.
 */
function shouldBroadcast(queryId: string): boolean {
  const registered = lookupRegisteredQuery(queryId)
  if (!registered) return false
  return registered.__spec.crossTab === true
}
