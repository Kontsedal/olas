---
name: field-value-shape
description: Field.value returns T directly; Form.value and FieldArray.value are ReadSignal<...>. They are not parallel.
type: pitfall
covers:
  - packages/core/src/forms/field.ts:37-75
  - packages/core/src/forms/form.ts:138-149
edges:
  - { type: tested-by, target: ../../packages/core/tests/form.test.ts }
  - { type: uses, target: ../modules/forms.md }
last_verified: 2026-05-22
confidence: high
---

# `Field.value` ≠ `Form.value`

## The trap

```ts
const field = ctx.field('hello')                # Field<string>
const form  = ctx.form({ name: field })         # Form<{ name: Field<string> }>

field.value         // 'hello'   — direct value
form.value          // Signal-ish; the value is at form.value.value
form.value.value    // { name: 'hello' }
```

`Field<T>` extends `ReadSignal<T>`, so `field.value` is `T` (via the getter on ReadSignal).

`Form<S>` is NOT a ReadSignal — it has a `value: ReadSignal<FormValue<S>>` field that IS a ReadSignal. So `form.value.value` is the data; `form.value` is the signal you'd subscribe to.

Same for `FieldArray`.

## Why it's this way

Per spec §20.7: "Field<T> *is* a ReadSignal<T> — `use(field)` in the UI works, `field.value` reads, `field.set(x)` writes." Making Field behave like a signal lets `useField(field)` and `<input value={field.value} onChange={e => field.set(e.target.value)} />` Just Work.

Forms aren't signals — they're aggregates. Making them implement ReadSignal would force `form.subscribe(handler)` to fire whenever any leaf changes, which is rarely what you want; you usually subscribe to specific fields.

The asymmetry is intentional but it's a footgun for traversal code.

## The bug we hit

Phase 8's initial `Form.computeValue`:

```ts
// BAD — assumed every child has .value as a ReadSignal
private computeValue(): FormValue<S> {
  const out = {}
  for (const [k, child] of Object.entries(this.fields)) {
    out[k] = child.value.value   # for a Field, .value is T, not a signal — .value.value is undefined
  }
  return out
}
```

Every test that touched `form.value.value` returned objects full of `undefined`.

Fix: branch on the brand:

```ts
private computeValue(): FormValue<S> {
  const out = {}
  for (const [k, child] of Object.entries(this.fields)) {
    if (isForm(child) || isFieldArray(child)) {
      out[k] = (child as { value: ReadSignal<unknown> }).value.value
    } else {
      // Field IS a ReadSignal — `.value` is the actual value.
      out[k] = (child as Field<unknown>).value
    }
  }
  return out
}
```

Same fix applies to `FieldArray.computeValue` (line ~290 of `form.ts`).

## How to spot this when reviewing changes

Any time you write `child.value.value` in form-traversal code, ask: is `child` definitely a Form or FieldArray? If it could be a Field, this is wrong — use `(child as Field<unknown>).value` instead. The `isForm` / `isFieldArray` / `isField` predicates from `form.ts` exist to make this branch explicit.

## Future: should we fix this asymmetry?

Possibly. Options:
- Add a `Form.read(): FormValue<S>` getter alias for `form.value.value`. Saves the double-`.value` and reads more naturally.
- Make `Field.value` return a signal too (breaking change, defeats the spec's "Field IS a ReadSignal" property).

Neither is on the v1 roadmap. The asymmetry has shipped; CLAUDE.md and this page document it.
