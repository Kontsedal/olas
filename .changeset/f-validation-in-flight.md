---
"@kontsedal/olas-core": patch
---

**A check in flight ends with its field: dispose settles it, and reset drops its result.**

Disposing a field, form or field array during an async validation left `isValidating` stuck at `true`, so a `revalidate()`, `validate()` or `submit()` waiting on it never resolved. Removing a row from a field array mid-submit therefore hung the submission: `isSubmitting` stayed `true`, and every later `submit()` returned `{ ok: false, reason: 'busy' }`. `dispose()` now ends the pass. A submission over the remaining rows completes, and a form disposed while it validates resolves `{ ok: false, reason: 'disposed' }` without calling the handler.

`reset()` also drops a check still in flight. A validator that ignores its `AbortSignal` could land its result on the reset field, so a `validateOn: 'submit'` field showed `['taken']` after `revalidate()` and `reset()`.
