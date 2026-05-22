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
  /**
   * Soft byte-size limit on a single outbound message. When the JSON-
   * serialized estimate exceeds this, the plugin calls `onWarn(...)` and
   * still posts the message — the cap is a heads-up, not an enforced
   * limit, because the underlying `BroadcastChannel` has its own
   * (browser-defined) cap and the right ceiling depends on use case.
   *
   * Defaults to `512 * 1024` (512 KB). Set to `Infinity` to disable.
   */
  maxPayloadBytes?: number
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
  const maxPayloadBytes = options.maxPayloadBytes ?? 512 * 1024

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
  // Per-peer monotonic-id cursor for out-of-order / duplicate drops. We cap
  // the number of distinct peers we remember so a long-lived root that sees
  // many short-lived peers (tabs that open, write once, and close) doesn't
  // grow this Map without bound. When the cap is hit we evict in insertion-
  // order (LRU-ish — peers we haven't heard from in the longest time go
  // first). A peer we later hear from again will simply start with `last=-1`
  // and accept its next message; the only cost of eviction is a one-message
  // dedup miss in the rare case the transport actually echoes that exact
  // peer's last-seen message back to us, which `BroadcastChannel` does not.
  const MAX_PEERS = 64
  const seenByPeer = new Map<string, number>()
  let api: QueryClientPluginApi | null = null
  let channel: ChannelLike | null = null

  const recordPeerMsg = (peerId: string, msgId: number): void => {
    // LRU touch — delete + set re-inserts at the tail so the oldest peers
    // sit at the head of the iterator.
    if (seenByPeer.has(peerId)) seenByPeer.delete(peerId)
    seenByPeer.set(peerId, msgId)
    if (seenByPeer.size > MAX_PEERS) {
      const oldest = seenByPeer.keys().next().value
      if (oldest !== undefined) seenByPeer.delete(oldest)
    }
  }

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
    recordPeerMsg(msg.sourceId, msg.msgId)

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
    // Cheap byte-size estimate via JSON length. Doesn't account for binary
    // structured-clone overhead but is correct within a small constant
    // factor — enough to flag "you're shipping 50 MB to peers" cases.
    if (maxPayloadBytes !== Number.POSITIVE_INFINITY) {
      let estimate = 0
      try {
        estimate = JSON.stringify(msg).length
      } catch {
        // If we can't JSON-stringify it, structured clone will likely fail
        // too — let the postMessage path catch and warn.
      }
      if (estimate > maxPayloadBytes) {
        onWarn(
          `[olas/cross-tab] payload for ${msg.type}` +
            ` queryId="${(msg as { queryId?: string }).queryId ?? ''}" is ${estimate} bytes,` +
            ` over the ${maxPayloadBytes}-byte soft cap. Consider entities or thinner queries.`,
        )
      }
    }
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

  let initialized = false
  return {
    init(a) {
      // The plugin instance owns one `sourceId`, one channel, and one
      // listener Map. Sharing it across two roots would clobber that state
      // on the second `init` and leak the first channel. Construct a fresh
      // `crossTabPlugin({ ... })` per root.
      if (initialized) {
        throw new Error(
          '[olas/cross-tab] crossTabPlugin instance reused across multiple roots. ' +
            'Each root must get its own `crossTabPlugin({ ... })`.',
        )
      }
      initialized = true
      api = a
      channel = factory(channelName) ?? null
      channel?.addEventListener('message', listener)
    },

    onSetData(event: SetDataEvent) {
      // Don't echo inbound writes — Layer-1 sender-side echo prevention.
      if (event.isRemote) return
      // Fetch-success writes are a per-tab concern: every tab runs its own
      // fetcher and would otherwise rebroadcast results to peers that just
      // fetched the same data themselves. We only echo explicit `setData`
      // calls (mutations, optimistic patches, entity backprop) cross-tab.
      if (event.source === 'fetch') return
      // Infinite queries are opt-in: page arrays are heavy enough that
      // silent cross-tab sync of every mutation can saturate the channel.
      // `crossTab: 'infinite'` or `'both'` on the spec lifts the gate.
      const mode = shouldBroadcast(event.queryId)
      if (mode === false) return
      if (event.kind === 'infinite' && mode !== 'infinite' && mode !== 'both') return
      if (event.kind === 'data' && mode === 'infinite') return

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
      const mode = shouldBroadcast(event.queryId)
      if (mode === false) return
      if (event.kind === 'infinite' && mode !== 'infinite' && mode !== 'both') return
      if (event.kind === 'data' && mode === 'infinite') return

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
      seenByPeer.clear()
      // Allow re-`init` only if a future runtime explicitly reattaches; today
      // `QueryClient.dispose` is final, so this is mostly defensive.
      initialized = false
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
 * Per-query gate. `crossTab: true` (or `'data' | 'infinite' | 'both'`) is a
 * static opt-in on the spec; the QueryClient doesn't filter on it (its
 * events fire for every query with a `queryId`), so the plugin checks here.
 *
 * Returns the requested mode (`'data' | 'infinite' | 'both'`) or `false` if
 * not opted in. Legacy `crossTab: true` maps to `'data'` (current behavior).
 */
function shouldBroadcast(queryId: string): 'data' | 'infinite' | 'both' | false {
  const registered = lookupRegisteredQuery(queryId)
  if (!registered) return false
  const flag = (registered.__spec as { crossTab?: boolean | 'data' | 'infinite' | 'both' }).crossTab
  if (flag === true) return 'data'
  if (flag === 'data' || flag === 'infinite' || flag === 'both') return flag
  return false
}
