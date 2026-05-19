/**
 * Wire protocol for `@olas/cross-tab` messages. SPEC §13.2.
 *
 * `v` (protocol version) and `sourceId` (per-plugin-instance unique tag)
 * combine to make the three-layer echo prevention work:
 *
 * 1. Sender skips broadcast when `SetDataEvent.isRemote === true` (the
 *    write originated from `applyRemoteSetData`).
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
