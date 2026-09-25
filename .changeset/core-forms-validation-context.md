---
"@kontsedal/olas-core": patch
---

**`form.submit()` validates first inside `batch()` and effects, and a form's state matches what a fresh one would show.**

Inside `batch()` or an effect, a field write starts its validator when that ends. `revalidate()` checked for a pending pass before that, so `batch(() => { username.set('taken'); form.submit(save) })` ran `save` while the async check was pending. `revalidate()`, `validate()` and `submit()` now wait for the pass the write started.

A `debouncedValidator` whose `fn` threw synchronously, or returned no promise, left the field validating for good, and a form's `isSubmitting` stuck. That failure now settles the pass the way a throwing sync validator does: the message shows and the error reaches `onError`.

`reset()` cleared a field's validator errors without re-running a sync validator when the value did not change, so a pristine `required()` field read valid after `form.reset()`. It now reads as a fresh field with that value would. An async validator is not re-sent for an unchanged value; `submit()` still runs it.

`form.dirtyFields` left out a field array whose rows were added, removed or moved, while `isDirty` counted it. Such an array is now listed by its own path, such as `tags`. A `null` row in a field array of forms built from a reactive `initial` threw out of the signal write. The row now builds from its schema defaults, and a throw while seating the form reaches `onError`. A field array builds its new rows before it drops the old ones, so a factory throw leaves it whole.

`form.setErrors` with a path naming a nested form or a field array dropped the messages, or split them into stray paths. They now land on that node's `topLevelErrors` until its value next changes, and `''` names the form itself.

The state members typed `ReadSignal` were the writable signals behind them, so a cast could write `field.touched` or `array.items` and skip item disposal. They are read-only views now: `field.touched`, `field.isDirty`, `field.isValidating`, `form.isSubmitting`, `form.submitCount`, `form.submitError` and `array.items`.
