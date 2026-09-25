---
"@kontsedal/olas-core": patch
---

**A reactive `initial()` keeps edits made while it loads, and its throws reach `onError`.**

The first defined value `initial()` returned seated the form even when the form was already dirty. Data that loaded after the user started typing therefore overwrote the edit, under the default `resetOnInitialChange: 'when-clean'` too. The first value now keeps every edit; the entry on the first `initial()` value has the per-field rule. `'never'` seats the form once, from the first defined value or from a `reset()` that seats one.

A throw from `initial()` escaped into whatever wrote the signal it read. A refetch whose data changed shape rejected with the form's `TypeError`, and the query showed `status: 'error'` while holding the new data. The throw now reaches the root's `onError` as `kind: 'effect'`, as a validator throw does, and the form keeps its values.
