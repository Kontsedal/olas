---
"@kontsedal/olas-persist": patch
---

**`persistQueryCachePlugin` stores server truth, never a guess, and stores a commit.**

- The plugin stores each entry's server truth, the write event's `server`. A `write`, a `replace` or an infinite page fetched while an optimistic write was live used to store the guess on screen, and a reload brought a failed guess back.
- A committed optimistic write is stored, stamped with the server time of the data it was made on.
- A commit on an entry the server never answered for, such as an optimistic create, is not stored. It is stamped `0`, and a restore would drop it under `maxAgeMs`; the next load fetches it.
