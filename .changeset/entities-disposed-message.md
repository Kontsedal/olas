---
"@kontsedal/olas-entities": patch
---

Calling a disposed plugin now says the plugin was disposed.

`dispose()` clears the same store that the registration check probes. So every call afterwards reported `entity "X" was not registered with entitiesPlugin([...])`, sending the reader to hunt for a missing registration that was there all along. The disposed case now has its own message. An entity missing from `entitiesPlugin([...])` still reports what it did before.
