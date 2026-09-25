/**
 * `@kontsedal/olas-cross-tab` — BroadcastChannel-backed in-memory cache sync across
 * tabs of the same origin. See SPEC §13.2 and the package README.
 */

declare module '@kontsedal/olas-core' {
  interface QueryMeta {
    /**
     * Mirror this query's writes and invalidations across same-origin tabs
     * (`@kontsedal/olas-cross-tab`). Regular and infinite queries both sync;
     * an infinite query's pages travel with their page params.
     */
    crossTab?: boolean
  }
}

export type { ChannelLike } from './channel'
export { defaultChannelFactory } from './channel'
export { CROSS_TAB_PLUGIN_NAME, type CrossTabOptions, crossTabPlugin } from './plugin'
export {
  type InvalidateMessage,
  type Message,
  PROTOCOL_VERSION,
  type RelayedSource,
  type SetDataMessage,
} from './protocol'
