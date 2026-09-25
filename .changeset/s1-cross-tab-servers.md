---
"@kontsedal/olas-cross-tab": patch
---

**Security fix: cross-tab opens no channel on a server, and a forged message can no longer silence a peer.**

- **The default channel factory opens a `BroadcastChannel` only in a browser tab or a web worker.** Node, Bun and Deno define `BroadcastChannel` too, and there it reaches every root in the process, and other worker threads or isolates. A server that built a root per request with `crossTabPlugin` opened a real channel per request, so one user's cache writes rendered in another user's response. On a server the plugin now installs no hooks. A `channelFactory` still opens a channel wherever it returns one: `channelFactory: (name) => new BroadcastChannel(name)`.
- **A receiver moves a peer's `msgId` cursor only for a message it applied.** One malformed message carrying a real peer's `sourceId` and `msgId: Number.MAX_SAFE_INTEGER` used to silence that peer for good. A `msgId` 64 or more below the cursor now restarts it, so even a well-formed forged message stops mattering once the real peer speaks again.
