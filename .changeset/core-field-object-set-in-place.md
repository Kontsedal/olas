---
"@kontsedal/olas-core": patch
---

**A `set` of the object a field already holds counts as a change, and every form baseline is a copy of its own.**

Svelte writes a nested bind on a raw field, `bind:value={$person.first}`, by assigning the member on the field's own value object and passing that object back to `set`. The field compared by reference, so it heard no change: no validator ran and `isDirty` stayed `false`. Its `initial` was that same object, so `reset()` returned the edited value.

Now `set` of the held object notifies, re-validates and recomputes `isDirty`, as a Svelte store's `set` does. A primitive equal to the current value is still no change, and `setAsInitial` and `reset` still leave the same object alone. A field keeps what `reset()` restores as a structural copy. Plain objects and arrays are copied at every depth, and a class instance, a `Date` or a `Map` is kept by reference, so a copy compares equal and does not read as dirty. A form keeps a fixed `initial` object the same way, and a field array its initial rows. The value stays the object passed in, so `field.set(x)` leaves `field.value === x`.
