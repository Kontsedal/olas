---
"@kontsedal/olas-core": minor
"@kontsedal/olas-devtools": minor
---

Devtools causal timeline (overhaul T8.1 + T8.4).

**Core** — `DebugEvent` gains optional `seq` / `t` / `causeId` correlation fields (stamped by the bus), plus new `cache:set-data` (carries `source` + the post-write `data`) and `snapshot:push` / `snapshot:rollback` / `snapshot:finalize` events. A mutation run's id and each fetch's id thread through the writes and snapshot events they trigger, so a whole optimistic-update chain shares one `causeId`. All dev-only — stripped from production builds. See SPEC §14.

**Devtools** — new default **Timeline** tab: every event ordered by `seq` and grouped by `causeId` into collapsible cause-chains, each `cache:set-data` expandable to a structural before/after diff. The cache Inspector is now event-driven (the 800ms poll is gone). Also fixes a real-browser `Illegal invocation` crash of the rAF-coalesced flush (native `requestAnimationFrame` was assigned unbound), which had silently left the Cache / Mutations / Fields / Timeline views empty in every browser.
