/**
 * Wire format for a persisted mutation entry. Stored under a per-runId key
 * (`<keyPrefix>/<mutationId>/<runId>`) so the plugin can list the live
 * queue by reading all keys matching the prefix.
 *
 * `v` is a protocol version so a future schema change can be migrated or
 * dropped cleanly. `attempts` counts replay attempts (NOT retries within
 * a single `mutate` call — those happen inside core). `enqueuedAt` is the
 * absolute timestamp (ms since epoch) used for ordering on replay.
 */
export type QueueEntry = {
  readonly v: 1
  readonly mutationId: string
  readonly runId: string
  readonly variables: unknown
  readonly attempts: number
  readonly enqueuedAt: number
  /**
   * Monotonic counter assigned at enqueue time. Replay ordering uses `seq`
   * in preference to `enqueuedAt` so wall-clock drift (NTP correction,
   * user-set-back time, suspend resume) can't reorder pending mutations.
   * Optional for backward compatibility — entries written before v0.0.8 do
   * not carry `seq`; they fall back to `enqueuedAt` ordering during replay.
   */
  readonly seq?: number
  /**
   * Client-supplied dedupe key. When two enqueues share an
   * `idempotencyKey`, the second is collapsed onto the first (kept value
   * is the first's, second is dropped). Server-side dedupe is the
   * authoritative gate; this is a client-side cost reduction. Optional —
   * absence means "every enqueue is unique."
   */
  readonly idempotencyKey?: string
}

export const PROTOCOL_VERSION = 1
