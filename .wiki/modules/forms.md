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
last_verified: 2026-07-25
confidence: high
---

# `packages/core/src/forms/`

## Purpose

Form primitives — `Field<T>`, `Form<S>`, `FieldArray<I>` — plus stdlib validators (`required`, `min`, `max`, `minLength`, `maxLength`, `email`, `pattern`) and `debouncedValidator`. Spec §8, §20.7.

## Files

- **`types.ts`** — `Validator<T>`, `ValidatorResult` (`string | null | FormIssue[]`), and `FormIssue` (`{ path: (string|number)[]; message }`). Validators may target descendant fields by path (T5.2).
- **`validators.ts`** — stdlib functions + the Standard-Schema `validator()` adapter. Stdlib fns return `Validator<T>` and short-circuit on `null` / `undefined` so they compose with `required()`. `validator(schema)` returns **all** issues as `FormIssue[]` (each with its `path`) — `[]` on success.
- **`field.ts`** — `FieldImpl<T>` class + `createField` factory + `debouncedValidator`. Field IS a `ReadSignal<T>` (delegates `.value` / `peek` / `subscribe` to an internal signal). Owns the validator runner. Three error channels merged into `errors`: `validatorErrors$` (own validators), `serverErrors$` (`setErrors`), `formErrors$` (parent-form-validator routing — T5.2).
- **`form-types.ts`** — heavy type machinery: `FormSchema`, `FormValue<S>`, `FormErrors<S>`, `FieldArrayValue<I>`, `Form<S>`, `FieldArray<I>`. Plus the brand symbols.
- **`form.ts`** — `FormImpl` and `FieldArrayImpl` + factories + brand-based predicates + the form-issue router (`resolveNode` / `routeFormIssues`).
- **`index.ts`** — re-exports validators + the `Validator` / `ValidatorResult` / `FormIssue` types.

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

The whole body runs inside an `effect`, so any signal read inside any validator becomes a tracked dependency — that's what makes cross-field rules like `(v) => v === password.value ? null : 'mismatch'` reactive. The async portion (`.then`) is outside the tracking scope. A validator that returns a `FormIssue[]` is flattened to its messages here (`messagesFromResult` — a leaf field has no descendants to route paths to).

`debouncedValidator(fn, ms)` returns a validator whose Promise resolves after `ms` (or rejects with AbortError if the signal aborts first). Its return type is the precise `(v, s) => Promise<string | null>` (not the widened `Validator<T>`), so a direct caller that stores the result in a `string | null` signal type-checks — still assignable wherever a `Validator<T>` is expected (`field.ts:545-548`).

## Form-level validators that target fields (T5.2)

A form-level validator (`FormOptions.validators`) or array-level validator (`FieldArrayOptions.validators`) may return a `FormIssue[]` instead of a `string`. `FormImpl.runTopLevelValidators` / `FieldArrayImpl.runTopLevelValidators` collect all results (sync + async, via `appendIssues`) and hand them to `routeFormIssues(this, issues, topLevelErrors$, lastTargets)` (`form.ts`):

- **empty-path** (and unresolvable) issues → the node's own `topLevelErrors$`.
- **path** issues → `resolveNode(this, path)` walks keys (Form) / numeric indices (FieldArray) to the target node, whose `setFormErrors(msgs)` is called.

Each node type (`FieldImpl`, `FormImpl`, `FieldArrayImpl`) exposes `setFormErrors`. On a Field it feeds `formErrors$` (merged into `errors`); on a Form/FieldArray it feeds `parentFormErrors$`, merged into that node's **`topLevelErrors`** getter (now a `computed` over own + parent-injected) and factored into `isValid`. `routeFormIssues` clears any target written last run but not this one (tracked in `lastFormErrorTargets`), so a fixed rule removes its message. The router runs inside the validator `effect` but only *reads* the tracked form `value` and *writes* error signals (peeks elsewhere), so it adds no spurious dependencies and can't loop (errors aren't part of `value`). Pinned by `regressions.test.ts` (R-F5.2); the Standard-Schema path (`validator(schema)` → `FormIssue[]`) is pinned by `standard-schema.test.ts`.

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

**Structural dirtiness (T5.1).** `FieldArray.isDirty` is `structurallyDirty$ || anyItemDirty` — the `structurallyDirty$` signal is flipped by `add`/`insert`/`remove`/`move`/`clear` and cleared by `reset()` and `replaceInitialItems()` (the initial re-anchor). Item-level dirtiness alone missed add/remove/move, so a reactive `initial: () => queryData` + the default `resetOnInitialChange: 'when-clean'` (`FormImpl` construction guard, `form.ts:99-124`) re-seated the array on a background refetch and deleted rows the user had just added. Construction seeds items directly (not via `add()`), so a fresh array is clean. Pinned by `regressions.test.ts` (R-F5.1).

## What's NOT implemented yet

- `form.fieldAt('a.b.c')` path-typed lookup — spec §20.7 says this is "deferred to post-v1". Use `form.fields.a.fields.b.fields.c` chained access.

Reactive `initial` **is** implemented (this page's prior "not reactive between resets" note was bootstrap-era drift): a `initial: () => …` thunk runs in a tracking scope and re-applies when its tracked signals change, gated by `resetOnInitialChange` (`'when-clean'` default / `'always'` / `'never'`). The `'when-clean'` guard consults `isDirty` — which now includes structural FieldArray edits (above). Spec §8.4, §8.5.
