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

/**
 * The write sources a tab relays. A fetch and a hydration are per tab, and
 * never cross.
 */
export type RelayedSource = 'write' | 'replace' | 'optimistic' | 'rollback' | 'commit'

/**
 * What a tab posts when the app writes a synced query's data outside a fetch
 * or hydration. A receiving tab applies `data` to the same entry, as what
 * `source` says it is:
 *
 * - `'write'` and `'replace'` are canonical. The receiver writes the server
 *   truth, `server.data` when the sender's data held a guess and `data`
 *   otherwise, as a patch or as a replace that supersedes its own fetch.
 * - `'optimistic'` is a guess. The receiver shows `data` as a guess of its
 *   own, which leaves its stale clock alone and waits for the sender's
 *   rollback or commit.
 * - `'rollback'` removes that guess. `server` present means the sender still
 *   shows other guesses, and the receiver shows `data` as one.
 * - `'commit'` makes `data` the receiver's data as a commit does: the guess
 *   is committed, and the stale clock is left alone.
 */
export type SetDataMessage = {
  v: typeof PROTOCOL_VERSION
  type: 'setData'
  sourceId: string
  msgId: number
  queryId: string
  keyArgs: readonly unknown[]
  data: unknown
  /**
   * Present for an infinite query: the params of `data`'s pages, one per page.
   */
  pageParams?: readonly unknown[]
  /**
   * What produced the write in the sending tab. Absent from the messages of
   * versions before 1.0, which a receiver applies as a `'write'`. A value a
   * receiver does not know drops the message.
   */
  source?: RelayedSource
  /**
   * The sender's server truth beneath the guesses its `data` holds, sent with
   * a `'write'`, `'replace'` or `'rollback'` made while an optimistic write
   * was live there.
   */
  server?: {
    data: unknown
    /**
     * For an infinite query, the params of the server pages.
     */
    pageParams?: readonly unknown[]
  }
}

/**
 * What a tab posts when the app invalidates a synced query entry. A receiving
 * tab invalidates the same entry.
 */
export type InvalidateMessage = {
  v: typeof PROTOCOL_VERSION
  type: 'invalidate'
  sourceId: string
  msgId: number
  queryId: string
  keyArgs: readonly unknown[]
}

/** A message on the channel, told apart by `type`. */
export type Message = SetDataMessage | InvalidateMessage
