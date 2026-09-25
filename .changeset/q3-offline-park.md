---
"@kontsedal/olas-core": patch
---

**`cancel()` drops a fetch parked for the network, and a fetch made online ends the park.**

`cancel()` did nothing when no request was in flight, so a fetch parked offline survived it and landed over the optimistic value written next, once the network returned. It now clears `isPaused`, stops waiting for reconnect and rejects the parked callers with an `AbortError`, as it does for a request in flight. A fetch made after the network came back, before an `online` event reached the entry, left the park in place. A parked `invalidate()` then never settled, and the later event made one more request and aborted work in flight. That fetch now serves the parked callers. Infinite queries do the same for parked refetches and page requests.
