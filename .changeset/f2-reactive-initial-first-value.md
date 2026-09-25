---
"@kontsedal/olas-core": patch
---

**The first `initial()` value fills the fields the user has not edited.**

The dirty guard on a reactive `initial()` covered the first defined value as a whole. One edit made before the data loaded therefore kept every other field at its empty seed. A keystroke in one field blocked the whole seat. So did a default the factory set with `form.set(...)`, or a `FieldArray` row added before `createForm`. A save then wrote blanks over the record. The first value now seats every leaf the user has not edited. An edited field keeps its value, and the loaded value becomes its baseline, so `isDirty` and `reset()` compare against it. A changed `FieldArray` keeps its rows the same way and stays dirty. Later values keep the form-wide guard.

`reset()` now reads `initial()` untracked. A `reset()` inside an effect no longer subscribes that effect to what the thunk reads. A throw from the thunk reaches `onError` as the reactive seat's does, instead of the caller. A `reset()` that seats a defined value counts as the one seat `resetOnInitialChange: 'never'` allows, so a later value no longer re-seats the form.
