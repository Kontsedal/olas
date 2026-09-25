---
"@kontsedal/olas-svelte": patch
---

**A nested bind on an object-valued `fieldStore`, `bind:value={$person.value.first}`, writes the field and leaves its `initial` alone.**

Svelte writes that bind by assigning `first` on the object the store handed out, then passing the state back to `set`. `fieldStore` handed out the field's own value object, which is also its `initial` until the first write. So the assignment changed `initial` in place, and `set` passed the same object back, which is no change to a signal. No validator ran, `isDirty` stayed `false`, and `reset()` gave back the edited value. Each subscriber now gets a shallow copy of a plain-object or array value, so `set` writes a new value. A member two levels down is still shared with the field's value. A raw `Field` bound the same way, `bind:value={$person.first}`, is fixed in core: see the `@kontsedal/olas-core` changeset on setting an object in place.
