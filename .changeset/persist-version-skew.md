---
"@kontsedal/olas-persist": patch
---

Two fixes in `createPersisted`.

- **A reader without `version` no longer takes a versioned envelope for the value.** A tab left open across a deploy runs the old build next to the new one. When the new build set `version` and the old one did not, the old tab handed the whole `{"v":2,"d":"…"}` envelope to `deserialize` and put that object in the signal. A reader without `version` now unwraps the envelope. To keep that from misreading a value of yours with the same shape, the envelope now carries a marker, `{"$olas":1,"v":2,"d":"…"}`. Without `version`, a value is still written raw, and only a value a reader could take for an envelope is wrapped, as `{"$olas":1,"d":"…"}`. Stored data keeps reading as before: the unmarked envelope is still an envelope to a reader with `version`, and a build before 1.0 with `version` set reads the marked one.
- **A source that does not call back on subscribe keeps its first change.** `createPersisted` skipped the first call of the source's `subscribe` handler. That assumed every source calls it at once with the current value, as a signal does. A source that calls it only on a change, like an event emitter, lost its first change. Only a call made while `subscribe()` runs is skipped now.
