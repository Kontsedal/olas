declare module '@kontsedal/olas-core' {
  interface MutationMeta {
    /**
     * Persist every run of this mutation until it settles, and replay runs a
     * reload interrupted (`@kontsedal/olas-mutation-queue`). The mutation
     * must come from `defineMutation`, which registers it for replay.
     */
    persist?: boolean
  }
}

export { type MutationQueueOptions, mutationQueuePlugin } from './plugin'
export { PROTOCOL_VERSION, type QueueEntry } from './protocol'
