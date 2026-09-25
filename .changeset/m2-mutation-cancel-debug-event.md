---
"@kontsedal/olas-core": minor
---

**Devtools hears a cancelled mutation run as `mutation:cancel`.**

A superseded, reset or disposed run sent plugins a `'cancel'` and sent devtools nothing. A panel then paired the next settle with the wrong start. `DebugEvent` gains `{ type: 'mutation:cancel'; path; id?; reason: 'superseded' | 'reset' | 'dispose' }`. Dev builds send it for every run whose plugin event is `'cancel'`, with the same `reason` and the run id as `causeId`. A queued `serial` run dropped before it started sends one too, with no `mutation:run` before it.
