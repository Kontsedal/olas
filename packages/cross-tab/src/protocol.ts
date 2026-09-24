/**
 * Wire protocol for `@kontsedal/olas-cross-tab` messages. SPEC §13.2.
 *
 * `v` (protocol version) and `sourceId` (unique per root) combine to make
 * the three-layer echo prevention work:
 *
 * 1. The sender mirrors only the app's own writes: a write the plugin
 *    applied from a peer carries the plugin's name as its `origin`, so it is
 *    never sent back.
 * 2. Receiver filters its own `sourceId` (catches the case where the
 *    transport echoes the message back to the sender).
 * 3. Receiver dedupes by `(sourceId, msgId)` — duplicate or out-of-order
 *    messages from the same peer are dropped.
 *
 * Receivers also drop messages with a `v` they don't understand. The
 * channel name itself is user-supplied; consumers who want clean
 * cross-deploy isolation should embed a version in their `channelName`.
 */

export const PROTOCOL_VERSION = 1

export type SetDataMessage = {
  v: typeof PROTOCOL_VERSION
  type: 'setData'
  sourceId: string
  msgId: number
  queryId: string
  keyArgs: readonly unknown[]
  data: unknown
}

export type InvalidateMessage = {
  v: typeof PROTOCOL_VERSION
  type: 'invalidate'
  sourceId: string
  msgId: number
  queryId: string
  keyArgs: readonly unknown[]
}

export type Message = SetDataMessage | InvalidateMessage
