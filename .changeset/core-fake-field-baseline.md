---
"@kontsedal/olas-core": patch
---

**`fakeField` keeps its own copy of the baseline, as a real field does.**

An in-place edit of a fake field's object value, which is what a Svelte nested bind makes, reached the value `reset()` restores. The fake now copies plain objects and arrays with `copyPlainData` on construction and in `setAsInitial`, and `reset()` writes a fresh copy.
