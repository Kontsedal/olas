---
"@kontsedal/olas-core": patch
---

**A reset no longer hides a form-level rule that still fails.**

`field.reset()` and `field.setAsInitial()` cleared the messages a form-level validator had routed onto the field, and `form.reset()` cleared the form's `topLevelErrors`. When the reset left the form's value unchanged, the validator did not re-run, so the messages stayed gone and `form.isValid` read `true` until the next edit. `submit()` was safe, because it validates first.

The form-level run is now the only writer of those messages. A reset that changes the form's value re-runs the validators, which recompute them, and a reset that does not leaves their last result on screen. Validator errors and server errors still clear on `reset()`, as before. Nothing starts a new async run: a no-op reset during one leaves it to settle.
