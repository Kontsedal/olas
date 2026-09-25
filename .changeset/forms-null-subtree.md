---
"@kontsedal/olas-core": patch
---

**A `null` for a nested form or field array no longer throws.**

`form.set({ address: null })` threw on `Object.entries(null)`, and so did `setAsInitial` and the first seat of a reactive `initial()` when an API record held `null` for a nested object. A nested form or field array now treats `null` as it treats `undefined`: it keeps its current state. A field still takes `null` as its value.
