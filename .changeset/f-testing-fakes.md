---
"@kontsedal/olas-core": patch
---

**`fakeField` and `fakeAsyncState` behave like the real ones.**

A `fakeField` read `isValid: false` while `isValidating`, where a real field holds its settled validity. Its `reset()` restored only the value, `setErrors` overwrote the seeded errors, and `set()` neither updated `isDirty` nor cleared server errors. It now acts as a field with no validators. `setErrors` writes a separate server channel that `set()` clears, `set()` compares against the initial value for `isDirty`, and `reset()` clears dirty, touched and every error.

A `fakeAsyncState` given an `error` now has status `'error'`. Its `firstValue()` resolves with the data when there is any, as a real subscription does, and otherwise rejects with the error. A `'pending'` status reads as fetching, and as loading while there is no data. With no data, `firstValue()` stays pending, as a real subscription waits, instead of resolving `undefined`.
