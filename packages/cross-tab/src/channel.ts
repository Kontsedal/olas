/**
 * Tiny `BroadcastChannel`-shaped abstraction. Lets tests inject a fake
 * (a shared in-memory bus across multiple "tabs" in the same process) and
 * keeps server safety in one place: outside a browser, and with no
 * `channelFactory` override, the plugin opens no channel and installs no hooks.
 */

export type ChannelLike = {
  postMessage(data: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(): void
}

/**
 * Whether this global scope is a browser's: a document (a tab or an iframe),
 * or a web worker (dedicated, shared or service). Node, Bun and Deno define
 * `BroadcastChannel` too, but there a channel reaches every root in the
 * process, and other worker threads or isolates as well. A server that builds
 * a root per request would render one user's writes into another user's page.
 * A Deno or Bun worker has a `WorkerGlobalScope` like a browser worker, so
 * those runtimes are ruled out by name.
 */
function isBrowserScope(): boolean {
  const g = globalThis as {
    Deno?: unknown
    Bun?: unknown
    document?: unknown
    WorkerGlobalScope?: unknown
  }
  if (g.Deno !== undefined || g.Bun !== undefined) return false
  if (typeof g.document === 'object' && g.document !== null) return true
  const Scope = g.WorkerGlobalScope
  return typeof Scope === 'function' && globalThis instanceof Scope
}

/**
 * Default factory: wraps the platform `BroadcastChannel` in a browser tab or
 * a web worker. Returns `undefined` anywhere else, such as on a Node, Bun or
 * Deno server, and where `BroadcastChannel` is not defined. A
 * `channelFactory` passed to `crossTabPlugin` opens a channel wherever it
 * returns one.
 */
export function defaultChannelFactory(name: string): ChannelLike | undefined {
  if (typeof BroadcastChannel === 'undefined' || !isBrowserScope()) return undefined
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
