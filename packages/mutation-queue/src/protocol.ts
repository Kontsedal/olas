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
}

export const PROTOCOL_VERSION = 1
