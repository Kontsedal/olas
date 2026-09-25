---
"@kontsedal/olas-devtools": patch
---

**Under StrictMode, the panel's timeline shows the live controller tree once.**

A root's debug bus replays its live controllers to each new subscriber. StrictMode attaches a panel's own store, detaches it and attaches it again, and the second replay went onto the timeline too: two controllers showed four `controller:constructed` rows. A store attached again now takes a replay that repeats its tree as a tree update with no timeline row. That is a `controller:constructed` for a controller it already has live, or a `controller:suspended` for one it already has suspended. A controller that changed while the store was detached still gets its row.
