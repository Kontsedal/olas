---
name: forms
description: Field, Form, FieldArray, validators. Aggregate computeds branch on brand markers.
type: module
covers:
  - packages/core/src/forms/types.ts
  - packages/core/src/forms/field.ts
  - packages/core/src/forms/form.ts
  - packages/core/src/forms/form-types.ts
  - packages/core/src/forms/validators.ts
  - packages/core/src/forms/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/form.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/validators.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../decisions/brand-markers-not-classes.md }
  - { type: related, target: ../pitfalls/field-value-shape.md }
  - { type: related, target: ../pitfalls/fieldarray-factory-uses-initial.md }
last_verified: 2026-05-21
confidence: high
---

# `packages/core/src/forms/`

## Purpose

Form primitives — `Field<T>`, `Form<S>`, `FieldArray<I>` — plus stdlib validators (`required`, `min`, `max`, `minLength`, `maxLength`, `email`, `pattern`) and `debouncedValidator`. Spec §8, §20.7.

## Files

- **`types.ts`** — `Validator<T>` type only.
- **`validators.ts`** — stdlib functions. All return `Validator<T>`. Most short-circuit on `null` / `undefined` so they compose with `required()` cleanly.
- **`field.ts`** — `FieldImpl<T>` class + `createField` factory + `debouncedValidator`. Field IS a `ReadSignal<T>` (delegates `.value` / `peek` / `subscribe` to an internal signal). Owns the validator runner.
- **`form-types.ts`** — heavy type machinery: `FormSchema`, `FormValue<S>`, `FormErrors<S>`, `FieldArrayValue<I>`, `Form<S>`, `FieldArray<I>`. Plus the brand symbols.
- **`form.ts`** — `FormImpl` and `FieldArrayImpl` + factories + brand-based predicates.
- **`index.ts`** — re-exports validators + the `Validator` type.

`form.ts` is the longest file (~450 lines). Read it side-by-side with `form-types.ts`.

## Brand markers

```ts
const FORM_BRAND        = Symbol.for('olas.form')
const FIELD_ARRAY_BRAND = Symbol.for('olas.fieldArray')

isForm(x)        // x[FORM_BRAND] === true
isFieldArray(x)  // x[FIELD_ARRAY_BRAND] === true
isField(x)       // neither — defaults to Field
```

Used everywhere `Form`/`FieldArray`/`Field` are mixed in a child slot. We prefer brands over `instanceof` because the impl class isn't exported (so `instanceof` would couple consumers to internals) and because `Symbol.for(...)` survives bundling boundaries. See `../decisions/brand-markers-not-classes.md`.

## Aggregate computeds — the traversal pattern

`Form.value`, `errors`, `isValid`, `isDirty`, `touched`, `isValidating` are all `computed(() => ...)`. They iterate `Object.values(this.fields)` and **branch on the child's brand**:

- `isForm(child)` → recurse into `child.value.value` (Form/FieldArray expose `.value` as a `ReadSignal`).
- `isFieldArray(child)` → same.
- else (Field) → read `(child as Field<unknown>).value` directly (Field IS a ReadSignal, so `.value` is the typed value, not a signal wrapper).

This asymmetry is per spec §20.7 — see `../pitfalls/field-value-shape.md` for the long version.

## Validator runner (in FieldImpl)

```
effect(() => {
  value = this.value$.value              # tracked
  revalidateTrigger$.value               # tracked — bump to force re-run
  abort previous run
  syncErrors[]   = []
  asyncPromises[]= []
  for v of validators:
    r = v(value, abort.signal)
    push to sync or async
  if syncErrors.length: errors=sync, validating=false, return
  if asyncPromises.length === 0: errors=[], validating=false, return
  validating=true; errors=[]
  Promise.allSettled(asyncPromises).then(results => {
    if myId !== currentRunId: return    # superseded
    errors = collect(results); validating=false
  })
})
```

The whole body runs inside an `effect`, so any signal read inside any validator becomes a tracked dependency — that's what makes cross-field rules like `(v) => v === password.value ? null : 'mismatch'` reactive. The async portion (`.then`) is outside the tracking scope.

`debouncedValidator(fn, ms)` returns a `Validator<T>` whose Promise resolves after `ms` (or rejects with AbortError if the signal aborts first).

## `Form.set(partial)` — batched deep merge

Iterate `Object.entries(partial)`. For each key, dispatch on the child:

- Form → child.set(val)
- FieldArray → child.clear() then child.add(item) for each
- Field → child.set(val)

All inside `batch(() => ...)` so subscribers see one notification.

## `FieldArray<I>` — dynamic children

`itemFactory: (initial?: ItemInitial<I>) => I` produces a new item. **The factory MUST consume the `initial` argument** or `add(x)` will silently ignore `x`. Canonical pattern:

```ts
ctx.fieldArray((initial) => ctx.field(initial ?? ''))
ctx.fieldArray((initial) => ctx.form(schema, { initial }))
```

See `../pitfalls/fieldarray-factory-uses-initial.md`.

`remove(i)` calls `.dispose()` on the removed item (Field/Form/FieldArray all implement it). `clear()` disposes all items.

## What's NOT implemented yet

- `form.fieldAt('a.b.c')` path-typed lookup — spec §20.7 says this is "deferred to post-v1". Use `form.fields.a.fields.b.fields.c` chained access.
- Reactive `initial` thunk that re-applies when the underlying signal changes — partial: function form is invoked once at construction and once on `reset()`, but isn't reactive between resets. Spec §8.4 describes the full behavior.
