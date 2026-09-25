---
"@kontsedal/olas-core": patch
---

**The diverging call args warning fires when only the key hash makes two args equal.**

Keys hash as JSON round-trips them, so `{ max: Infinity }` and `{ max: -Infinity }` share one entry. The development warning for a second bind with other call args compared the args by the same hash, so it stayed silent there, and the fetcher kept the first bind's args unannounced. Call args now compare structurally, with no JSON normalization. A `Date` compares by its time, and a cyclic arg no longer warns by mistake.
