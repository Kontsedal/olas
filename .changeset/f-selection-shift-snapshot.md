---
"@kontsedal/olas-core": patch
---

**A programmatic selection change ends the shift-click run.**

A run of shift-clicks computes each range against the selection as it stood before the run began. Only a plain or meta click ended the run, so the second shift-click undid a `toggle`, `select`, `deselect`, `clear` or `selectAll` made in between. Click a, shift-click c, `toggle('z')`, shift-click y selected `{a, y, z}` and dropped b and c. Every programmatic change now ends the run.
