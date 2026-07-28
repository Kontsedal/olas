---
"@kontsedal/olas-core": minor
"@kontsedal/olas-devtools": minor
---

`ctx.debug({...})` — controller variables in devtools.

**Core** — new opt-in `ctx.debug(record)` primitive: registers named **live** values (signals / computeds / fields / plain values) for the devtools "Variables" view. Dev-only — a no-op in production (stripped like the rest of the `__debug` bus), so it costs nothing and retains nothing there. Construction-time registrations ride out on `controller:constructed` (new optional `debug` field); a call after construction emits the new `controller:debug` event. Both are replayed to late subscribers.

**Devtools** — each controller node in the Tree now shows its `ctx.debug` variables, rendered **reactively** (a signal shows its current value and updates live as it changes — no polling; a plain value shows a snapshot). Lazy per expanded node.
