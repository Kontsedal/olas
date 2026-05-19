/**
 * Tiny `BroadcastChannel`-shaped abstraction. Lets tests inject a fake
 * (a shared in-memory bus across multiple "tabs" in the same process) and
 * keeps SSR-safety in one place — when `BroadcastChannel` is absent and
 * no `channelFactory` override is supplied, the plugin returns a no-op
 * variant up the stack.
 */

export type ChannelLike = {
  postMessage(data: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(): void
}

/**
 * Default factory: wraps the platform `BroadcastChannel`. Returns
 * `undefined` when `BroadcastChannel` is not defined (SSR / Node without
 * `--experimental-broadcastchannel`, older browsers).
 */
export function defaultChannelFactory(name: string): ChannelLike | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined
  const ch = new BroadcastChannel(name)
  return {
    postMessage(data) {
      ch.postMessage(data)
    },
    addEventListener(type, listener) {
      // The platform BroadcastChannel typing wants a `MessageEvent`
      // listener, but we only care about `event.data` — cast through
      // `unknown` since the shapes don't structurally overlap.
      ch.addEventListener(type, listener as unknown as EventListener)
    },
    removeEventListener(type, listener) {
      ch.removeEventListener(type, listener as unknown as EventListener)
    },
    close() {
      ch.close()
    },
  }
}
