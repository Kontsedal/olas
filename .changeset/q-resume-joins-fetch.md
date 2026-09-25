---
"@kontsedal/olas-core": patch
---

**`resume()` no longer aborts a fetch already in flight.** A suspend and resume during a first fetch aborted it and fetched again. `resume()` now joins a running fetch, as a subscribing effect does, for regular and infinite queries.
