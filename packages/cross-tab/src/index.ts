/**
 * `@kontsedal/olas-cross-tab` — BroadcastChannel-backed in-memory cache sync across
 * tabs of the same origin. See SPEC §13.2 and the package README.
 */

export type { ChannelLike } from './channel'
export { defaultChannelFactory } from './channel'
export { type CrossTabOptions, crossTabPlugin } from './plugin'
export {
  type InvalidateMessage,
  type Message,
  PROTOCOL_VERSION,
  type SetDataMessage,
} from './protocol'
