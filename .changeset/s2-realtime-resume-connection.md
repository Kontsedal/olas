---
"@kontsedal/olas-realtime": patch
---

**`createConnectionState` no longer keeps a stale state across a suspend.**

A suspended controller leaves the shared `onConnectionChange` subscription. When it was the last user, the subscription closed, and a transport that reports only changes said nothing on the next subscribe. The signal kept its pre-suspend value, so a connection that came back during the suspend still read `'offline'` after resume, and `onReconnect` never fired. A resume now starts the state the way a new `createConnectionState` does: at the transport's latest report, or at `'connected'` when there is none. A move back to `'connected'` on resume runs `onReconnect`.
