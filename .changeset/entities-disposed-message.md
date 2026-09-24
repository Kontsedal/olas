---
"@kontsedal/olas-entities": patch
---

A call on a disposed entity store now says the store was disposed.

Disposing the root clears the same store that the registration check probes. Every call afterwards reported `entity "X" was not registered with entitiesPlugin({ entities })`, and sent the reader looking for a registration that was there all along. The disposed case now has its own message. An entity missing from `entitiesPlugin({ entities })` still gets the registration message.
