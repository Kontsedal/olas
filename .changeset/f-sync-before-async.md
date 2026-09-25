---
"@kontsedal/olas-core": patch
---

**Async validators start only after every sync validator passes, as SPEC §8.1 says.**

A pass called every validator and only then looked at the results, so `[required(), checkUsername]` sent `checkUsername('')` to the server. A pass now runs the sync validators first and does not call the async ones when a sync one fails. A pass cannot tell a sync validator from an async one before calling it. A validator therefore counts as async when it is declared `async`, or once it has returned a promise. The same order applies to form-level and array-level validators.
