---
"@kontsedal/olas-svelte": patch
---

**`bind:value={$state.value}` on a `fieldStore` writes the field's value.**

Svelte writes a member binding by assigning the member on the value the store handed it, then passing that whole value to `set`. `fieldStore`'s `set` sent it to `field.set` as it was, so typing "ab" left the field holding `{ value: 'ab', errors: [], … }`. Svelte also assigned into the core `computed`'s cached state object. `fieldStore` now hands each subscriber its own copy of the state, and `set` writes a copy's `value` to the field. A plain value still goes to `field.set` unchanged.
