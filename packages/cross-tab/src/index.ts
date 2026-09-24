/**
 * `@kontsedal/olas-cross-tab` — BroadcastChannel-backed in-memory cache sync across
 * tabs of the same origin. See SPEC §13.2 and the package README.
 */

declare module '@kontsedal/olas-core' {
  interface QueryMeta {
    /**
     * Mirror this query's writes and invalidations across same-origin tabs
     * (`@kontsedal/olas-cross-tab`). Regular queries only; infinite queries
     * do not sync.
     */
    crossTab?: boolean
  }
}

export type { ChannelLike } from './channel'
export { defaultChannelFactory } from './channel'
export { type CrossTabOptions, crossTabPlugin } from './plugin'
export {
  type InvalidateMessage,
  type Message,
  PROTOCOL_VERSION,
  type SetDataMessage,
} from './protocol'
