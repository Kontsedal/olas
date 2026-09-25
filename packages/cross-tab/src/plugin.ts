import type { InvalidateEvent, OlasPlugin, WriteEvent } from '@kontsedal/olas-core'
import { type ChannelLike, defaultChannelFactory } from './channel'
import { type Message, PROTOCOL_VERSION } from './protocol'

/** The plugin's name — and the `origin` stamped on writes it applies from peers. */
export const CROSS_TAB_PLUGIN_NAME = 'olas-cross-tab'

/**
 * Options accepted by `crossTabPlugin(...)`. SPEC §13.2.
 */
export type CrossTabOptions = {
  /**
   * Name of the `BroadcastChannel`. Include a version suffix for clean
   * cross-deploy isolation (e.g. `'my-app/cache/v2'`).
   */
  channelName: string
  /**
   * Called for non-fatal conditions: a `DataCloneError` while posting (the
   * data isn't structured-cloneable), an oversized payload, or a malformed
   * inbound message. Default: `console.warn`.
   */
  onWarn?: (message: string, cause?: unknown) => void
  /**
   * Override the channel constructor, for tests sharing an in-memory bus or a
   * runtime the default does not open a channel in. The default,
   * `defaultChannelFactory`, opens a `BroadcastChannel` only in a browser tab
   * or a web worker. Return `undefined` to turn cross-tab off.
   */
  channelFactory?: (name: string) => ChannelLike | undefined
  /**
   * Soft byte-size limit on a single outbound message. When the JSON-
   * serialized estimate exceeds this, the plugin calls `onWarn(...)` and
   * still posts the message — the cap is a heads-up, not an enforced limit,
   * because the underlying `BroadcastChannel` has its own (browser-defined)
   * cap. Defaults to `512 * 1024` (512 KB). `Infinity` disables it.
   */
  maxPayloadBytes?: number
  /**
   * Also mirror optimistic writes (`setData`) and their rollbacks, so peers
   * show a pending edit before the server confirms it. Default `true`. With
   * `false`, only canonical writes (`write`, `replace`) and invalidations
   * cross tabs.
   */
  optimistic?: boolean
  /**
   * Writes and invalidations from these origins are mirrored too. By default
   * only the app's own (origin `undefined`) are. A write another plugin made
   * is usually derived: a realtime push every tab receives, or an entity
   * backprop that the peer's own entities plugin re-derives from the mirrored
   * write. Mirroring those would deliver them twice. An `entities.update(...)`
   * patch is the exception: nothing re-derives it in a peer, so it stays in
   * its tab unless this list names `ENTITIES_PLUGIN_NAME`.
   */
  origins?: readonly string[]
  /**
   * Check a peer's `setData` payload before this tab writes it. Any same-origin
   * script can post on the channel, so a tab whose data shape matters can
   * reject what it did not expect: return `false` to drop the message, which
   * is reported through `onWarn`. Default: every payload is accepted.
   */
  validate?: (queryId: string, data: unknown) => boolean
}

/**
 * Generate a unique-enough source id for one root's channel. Collisions
 * across same-millisecond tab-opens are negligible, and even a collision
 * only loses dedup, not correctness.
 */
function makeSourceId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}-${rand}`
}

/**
 * What became of a peer's message, as the devtools lane reports it:
 * - `applied`: written or invalidated here;
 * - `duplicate`: its `msgId` is at most the last one applied from that peer,
 *   and less than 64 below it;
 * - `malformed`: a field has the wrong shape, or the type is unknown;
 * - `ignored`: this root has not bound the query, or has not opted it in;
 * - `rejected`: `validate` returned `false` or threw;
 * - `failed`: applying it threw, such as on a key the engine cannot hash.
 */
type Received = 'applied' | 'duplicate' | 'malformed' | 'ignored' | 'rejected' | 'failed'

/**
 * Cross-tab cache sync over `BroadcastChannel`. Mirrors writes and
 * invalidations of opted-in queries across tabs of the same origin.
 *
 * ```ts
 * const userQuery = defineQuery({ id: 'users/detail', …, meta: { crossTab: true } })
 *
 * createRoot(app, {
 *   deps,
 *   queries: queryEngine(),
 *   plugins: [crossTabPlugin({ channelName: 'my-app/cache/v1' })],
 * })
 * ```
 *
 * Only queries with `meta: { crossTab: true }` sync, on both the send and the
 * receive side. That covers infinite queries: their pages travel with their
 * `pageParams`, so the receiving tab keeps paging from them. Page arrays can be
 * large, and `maxPayloadBytes` warns about them. Fetches and hydration are a
 * per-tab concern — every tab runs its own fetcher — so they never cross.
 *
 * **Server safety.** Without a `channelFactory`, the plugin opens a channel
 * only in a browser tab or a web worker. On a Node, Bun or Deno server, and
 * where `BroadcastChannel` is not defined, it installs no hooks and the root
 * boots with cross-tab off. A server's `BroadcastChannel` reaches every root
 * in the process, so per-request roots would otherwise read each other's
 * writes. A `channelFactory` opens a channel wherever it returns one.
 *
 * **Non-cloneable data.** `BroadcastChannel` uses structured clone. Cache
 * data containing a function or a symbol throws a
 * `DataCloneError` at `postMessage`. The plugin catches it, calls
 * `onWarn(...)`, and drops the message — the sender's cache is unaffected.
 * A class instance does not throw: it arrives as a plain object, without its
 * prototype.
 */
export function crossTabPlugin(options: CrossTabOptions): OlasPlugin {
  const channelName = options.channelName
  const onWarn = options.onWarn ?? defaultWarn
  const factory = options.channelFactory ?? defaultChannelFactory
  const maxPayloadBytes = options.maxPayloadBytes ?? 512 * 1024
  const mirrorOptimistic = options.optimistic ?? true
  const extraOrigins = new Set(options.origins ?? [])
  const validate = options.validate

  return {
    name: CROSS_TAB_PLUGIN_NAME,
    setup(host) {
      const queries = host.queries
      if (queries === null) {
        throw new Error(
          '[olas/cross-tab] crossTabPlugin needs a query engine: ' +
            'createRoot(app, { queries: queryEngine(), plugins: [crossTabPlugin({ … })] })',
        )
      }
      const channel = factory(channelName)
      // A server, or a runtime without BroadcastChannel: nothing to sync with.
      if (!channel) return

      const sourceId = makeSourceId()
      let msgIdCounter = 0
      // Per-peer monotonic-id cursor for out-of-order / duplicate drops. Capped
      // so a long-lived root that sees many short-lived peers doesn't grow it
      // without bound; the oldest peers are evicted first. A peer we later hear
      // from again simply starts over.
      const MAX_PEERS = 64
      // How far below a peer's cursor a `msgId` still counts as a duplicate or
      // a late delivery. A `msgId` further below means the cursor is wrong: a
      // forged message under the peer's `sourceId` pushed it ahead. That
      // message is applied, and the cursor restarts from it.
      const REORDER_WINDOW = 64
      const seenByPeer = new Map<string, number>()
      const recordPeerMsg = (peerId: string, msgId: number): void => {
        if (seenByPeer.has(peerId)) seenByPeer.delete(peerId)
        seenByPeer.set(peerId, msgId)
        if (seenByPeer.size > MAX_PEERS) {
          const oldest = seenByPeer.keys().next().value
          if (oldest !== undefined) seenByPeer.delete(oldest)
        }
      }

      /** Receive-side mirror of the send gate: only opted-in queries, either kind. */
      const accepts = (queryId: string): boolean => {
        const ref = queries.get(queryId)
        return ref !== undefined && ref.meta.crossTab === true
      }

      /**
       * Apply a peer's message. A key the engine cannot hash (a `Map`, a cycle,
       * nesting deep enough to overflow) throws; it is reported through
       * `onWarn` instead of escaping the channel's event handler.
       */
      const applying = (apply: () => void): Received => {
        try {
          apply()
          return 'applied'
        } catch (cause) {
          onWarn('[olas/cross-tab] failed to apply a peer message', cause)
          return 'failed'
        }
      }
      /** A `validate` that throws rejects the message. */
      const safely = (check: () => boolean): boolean => {
        try {
          return check() === true
        } catch {
          return false
        }
      }

      /**
       * Apply a message that passed every check, and only then move its
       * peer's cursor. A message this tab ignores, rejects or cannot apply
       * leaves the cursor alone, so a forged `msgId` has to arrive on a message
       * this tab would apply before it can push the cursor ahead.
       */
      const commit = (peer: string, msgId: number, apply: () => void): Received => {
        const outcome = applying(apply)
        if (outcome === 'applied') recordPeerMsg(peer, msgId)
        return outcome
      }

      /** Check and apply one message a peer sent. Returns what became of it. */
      const receive = (msg: Partial<Message>): Received => {
        // Layer 3 — out-of-order / duplicate drop.
        // A `msgId` that is not a counter value, such as `Number.MAX_VALUE`, is
        // malformed. A forged high one on a well-formed message only moves the
        // cursor until the real peer speaks again: its `msgId` lands more than
        // `REORDER_WINDOW` below the cursor and restarts it.
        const msgId = msg.msgId
        const peer = msg.sourceId
        if (typeof peer !== 'string' || typeof msgId !== 'number') return 'malformed'
        if (!Number.isSafeInteger(msgId) || msgId < 0) return 'malformed'
        const last = seenByPeer.get(peer)
        if (last !== undefined && msgId <= last && last - msgId < REORDER_WINDOW) {
          return 'duplicate'
        }

        if (typeof msg.queryId !== 'string' || !Array.isArray(msg.keyArgs)) {
          onWarn(`[olas/cross-tab] malformed ${String(msg.type)} message`)
          return 'malformed'
        }
        if (!accepts(msg.queryId)) return 'ignored'
        if (msg.type === 'setData') {
          // Stamped with this plugin's name as `origin`, which is what keeps
          // the write from being mirrored straight back.
          const { data, pageParams } = msg as { data?: unknown; pageParams?: unknown }
          if (pageParams !== undefined && !Array.isArray(pageParams)) {
            onWarn('[olas/cross-tab] malformed setData message: pageParams is not an array')
            return 'malformed'
          }
          if (validate !== undefined && !safely(() => validate(msg.queryId as string, data))) {
            onWarn('[olas/cross-tab] setData message rejected by validate')
            return 'rejected'
          }
          // An infinite query's pages arrive with their params, so this tab can
          // keep paging from them.
          return commit(peer, msgId, () =>
            queries.write(
              msg.queryId as string,
              msg.keyArgs as unknown[],
              () => data,
              pageParams ? { pageParams } : undefined,
            ),
          )
        }
        if (msg.type === 'invalidate') {
          return commit(
            peer,
            msgId,
            () => void queries.invalidate(msg.queryId as string, msg.keyArgs as unknown[]),
          )
        }
        // A type this version does not know.
        return 'malformed'
      }

      const listener = (event: { data: unknown }) => {
        const msg = event.data as Partial<Message> | null
        if (!msg || typeof msg !== 'object') return
        // Layer 1 — protocol version drop.
        if (msg.v !== PROTOCOL_VERSION) return
        // Layer 2 — own-source drop (the transport echoed our own message).
        if (msg.sourceId === sourceId) return
        const outcome = receive(msg)
        // Every message a peer sent on this protocol goes on the devtools
        // lane, whatever became of it. `from` and `msgId` name the message in
        // the sender's lane too.
        if (__DEV__) {
          host.debug({
            kind: 'receive',
            type: msg.type,
            queryId: msg.queryId,
            outcome,
            from: msg.sourceId,
            msgId: msg.msgId,
            key: msg.keyArgs,
          })
        }
      }
      channel.addEventListener('message', listener)

      const send = (msg: Message): void => {
        // Cheap byte-size estimate via JSON length — correct within a small
        // constant factor, enough to flag "you're shipping 50 MB to peers".
        if (maxPayloadBytes !== Number.POSITIVE_INFINITY) {
          let estimate = 0
          try {
            estimate = JSON.stringify(msg).length
          } catch {
            // If it can't be JSON-stringified, structured clone will likely
            // fail too; the postMessage path catches and warns.
          }
          if (estimate > maxPayloadBytes) {
            onWarn(
              `[olas/cross-tab] payload for ${msg.type} queryId="${msg.queryId}" is ${estimate} ` +
                `bytes, over the ${maxPayloadBytes}-byte soft cap. Consider entities or thinner queries.`,
            )
          }
        }
        let posted = true
        try {
          channel.postMessage(msg)
        } catch (cause) {
          posted = false
          onWarn(
            `[olas/cross-tab] failed to broadcast ${msg.type} for queryId="${msg.queryId}": ` +
              'data is not structured-cloneable',
            cause,
          )
        }
        if (__DEV__) {
          host.debug({
            kind: 'send',
            type: msg.type,
            queryId: msg.queryId,
            outcome: posted ? 'posted' : 'not-cloneable',
            from: sourceId,
            msgId: msg.msgId,
            key: msg.keyArgs,
          })
        }
      }

      /** The send gate shared by writes and invalidations. */
      const mirrors = (event: WriteEvent | InvalidateEvent): boolean => {
        if (event.origin !== undefined && !extraOrigins.has(event.origin)) return false
        if (event.origin === CROSS_TAB_PLUGIN_NAME) return false
        return event.query.meta.crossTab === true
      }

      return {
        onWrite(event) {
          if (!mirrors(event)) return
          if (event.source === 'fetch' || event.source === 'hydrate') return
          if (!mirrorOptimistic && (event.source === 'optimistic' || event.source === 'rollback')) {
            return
          }
          send({
            v: PROTOCOL_VERSION,
            type: 'setData',
            sourceId,
            msgId: ++msgIdCounter,
            queryId: event.query.id,
            keyArgs: event.key,
            data: event.data,
            ...(event.pageParams !== undefined ? { pageParams: event.pageParams } : {}),
          })
        },

        onInvalidate(event) {
          if (!mirrors(event)) return
          send({
            v: PROTOCOL_VERSION,
            type: 'invalidate',
            sourceId,
            msgId: ++msgIdCounter,
            queryId: event.query.id,
            keyArgs: event.key,
          })
        },

        dispose() {
          channel.removeEventListener('message', listener)
          channel.close()
          seenByPeer.clear()
        },
      }
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
