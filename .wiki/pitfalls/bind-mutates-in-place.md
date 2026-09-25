---
name: bind-mutates-in-place
description: Svelte's nested bind and Vue's v-model on a member assign the member on the object a store or ref handed out; on a Field's own value that edits `initial` too, and the set that follows is no change to a signal.
type: pitfall
covers:
  - packages/svelte/src/index.ts:180-239
  - packages/vue/src/index.ts:270-318
  - packages/core/src/forms/field.ts
edges:
  - { type: tested-by, target: ../../packages/svelte/tests/svelte.test.ts }
  - { type: uses, target: ../modules/svelte.md }
  - { type: uses, target: ../modules/vue.md }
  - { type: related, target: ../modules/forms.md }
last_verified: 2026-09-25
confidence: medium
---

# A nested bind edits the value object in place

## The trap

Svelte compiles `bind:value={$person.value.first}` to an assignment on the object the store handed out, followed by `set` with that same object: `store_mutate(store, $person.value.first = v, $person)`. A Svelte store runs `safe_not_equal`, which calls every object changed, so the in-place edit plus `set(sameObject)` is how Svelte's own stores are meant to work.

An Olas `Field` is a signal, and a signal compares with `Object.is`. A `Field` holds its value object, and until the first write that object is also its `initial`. So on a field used as a store:
- the assignment edits the field's value, and its `initial`, in place;
- `set(sameObject)` is no change: no subscriber hears it, no validator runs, `isDirty` stays `false`;
- `reset()` returns `initial`, which is the edited object.

`fieldStore` handed out the field's own value object inside each state copy, so `bind:value={$person.value.first}` did all of the above. A raw `Field` bound as `bind:value={$person.first}` still does, because Svelte calls the field's own `subscribe` and `set` with no adapter code in between.

Vue has the same shape. `useField(field).value` is a writable `customRef` whose getter returns the field's value object, and `v-model="value.name"` assigns `name` on that object. The ref's setter never runs, so nothing calls `field.set`.

## The fix, and what is left

`fieldStore` hands each subscriber a shallow copy of a plain-object or array value (`copyValue`, `packages/svelte/src/index.ts:180-194`). Svelte's assignment lands on the copy, and `set` writes the copy to the field as a new value, so validators run, `isDirty` follows, and `initial` stays whole. A spread copies an own `__proto__` key as data, and a null-prototype object keeps its prototype (`proto-key-assignment.md`). A class instance, a `Date` or a `Map` goes out as it is. A member two levels down is still shared with the field's value.

**A raw `Field` in Svelte is fixed in core (1.0).** `set` of the object the field holds now counts as a change. Every baseline is the node's own structural copy, so no edit of the value reaches it; `../modules/forms.md` has the details under "An object value edited in place". Validators run, `isDirty` follows and `reset()` restores, at any depth, through `fieldStore` or on the raw field.

Two cases stay, and the docs name the workaround:
- **`v-model` on a member in Vue.** Nothing in the adapter sees the assignment, so the field is not notified until the next `set`. Its baseline is a copy now, so `reset()` restores. A write-through proxy on the ref's value could notify, but it changes the value's identity for every reader. Bind a writable `computed` that calls `set` with a new object, or a `Form`'s leaf field.
- **A shared value object**, in either adapter. The edit lands on the object the field holds, which is the one last passed to it. A field seated from query data holds the query's object, so the edit reaches the cache. Use a `Form`, whose leaves are fields of their own.

## The general rule

A reactive value handed to a framework that edits objects in place must be a copy the framework may edit, or a view whose writes go through the owner. Check the framework's equality contract before handing it an object: Svelte's calls every object changed, a signal's calls none changed unless the reference moves.

Pinned by `packages/svelte/tests/svelte.test.ts`: "a nested bind on an object-valued fieldStore writes a new value and leaves initial alone" types into `FieldObject.svelte`, and "fieldStore hands each subscriber a copy of an object value" checks the copies.
