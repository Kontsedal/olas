---
"@kontsedal/olas-core": patch
---

**A reactive `initial()` keeps edits made while it loads, and its throws reach `onError`.**

The first defined value `initial()` returned seated the form even when the form was already dirty. Data that loaded after the user started typing therefore overwrote the edit, under the default `resetOnInitialChange: 'when-clean'` too. The dirty guard now covers the first value. `'never'` seats the form once, from the first defined value that arrives while it is clean.

A throw from `initial()` escaped into whatever wrote the signal it read. A refetch whose data changed shape rejected with the form's `TypeError`, and the query showed `status: 'error'` while holding the new data. The throw now reaches the root's `onError` as `kind: 'effect'`, as a validator throw does, and the form keeps its values.
