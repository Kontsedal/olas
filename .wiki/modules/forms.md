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
  - { type: related, target: ../decisions/forms-are-read-signals.md }
  - { type: related, target: ../pitfalls/fieldarray-factory-uses-initial.md }
last_verified: 2026-09-24
confidence: high
---

# `packages/core/src/forms/`

## Purpose

Form primitives — `Field<T>`, `Form<S>`, `FieldArray<I>` — plus stdlib validators (`required`, `mustBeTrue`, `min`, `max`, `minLength`, `maxLength`, `email`, `pattern`) and `debouncedValidator`. `required` accepts a boolean `false`, which is a legitimate value. `mustBeTrue` is the consent-checkbox rule (T5.3). Spec §8, §20.7.

## Files

- **`types.ts`** — `Validator<T>`, plus `ValidatorResult` as `string | null | FormIssue[]` and `FormIssue` as `{ path: (string|number)[]; message }`. Validators may target descendant fields by path (T5.2).
- **`validators.ts`** — stdlib functions + the Standard-Schema `validator()` adapter. Stdlib fns return `Validator<T>` and short-circuit on `null` and `undefined` so they compose with `required()`. `validator(schema)` returns **all** issues as `FormIssue[]` (each with its `path`) — `[]` on success.
- **`field.ts`** — `FieldImpl<T>` class + `createField` factory + `debouncedValidator`. Field IS a `ReadSignal<T>`, delegating `.value`, `peek` and `subscribe` to an internal signal. It owns the validator runner. Three error channels merge into `errors`: `validatorErrors$` from its own validators, `serverErrors$` from `setErrors`, and `formErrors$` from parent-form-validator routing (T5.2).
- **`form-types.ts`** — heavy type machinery: `FormSchema`, `FormValue<S>`, `FormErrors<S>`, `FieldArrayValue<I>`, `Form<S>`, `FieldArray<I>`. Plus the brand symbols.
- **`form.ts`** — `FormImpl` and `FieldArrayImpl` + factories + brand-based predicates + the form-issue router (`resolveNode` and `routeFormIssues`).
- **`index.ts`** — re-exports validators + the `Validator`, `ValidatorResult` and `FormIssue` types.

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

`Form.value`, `errors`, `isValid`, `isDirty`, `touched`, `isValidating` are all `computed(() => ...)`. They iterate `Object.values(this.fields)`.

- **`value`** reads `child.value` for every child with no branch. `Field`, `Form` and `FieldArray` are each a `ReadSignal` of their value (`form.ts:277-284`). See `../decisions/forms-are-read-signals.md`.
- **`errors`, touched, validation and path resolution** branch on the child's brand, because the node kinds differ there: a `Form` has `fields`, a `FieldArray` has `items`, and a `Field` has neither.

`applyPartial` (behind `set` and `setAsInitial`) calls the child's own `set` or `setAsInitial`, which all three kinds share.

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

**`validateOn` gate.** A field can defer its first validation. `'change'` is the default and runs immediately. `'blur'` gates the first run on `markTouched()`. `'submit'` gates it on `revalidate()` and `Form.validate()`. A reactive `validateUnlocked$` gate short-circuits the runner while locked. Once unlocked it stays unlocked, so subsequent changes re-validate, and `reset()` re-locks. Covered by `form.test.ts`.

**`isValid` stability (T5.3).** `isValid` reads live `errors` when settled, but **holds the last settled validity while `isValidating`**, through a `lastValid$` signal updated at every settle point. Without this, a `debouncedValidator` cleared `validatorErrors$` on each async start, `isValid` strobed to `false` on every keystroke, and a bound submit button flickered. A field with no prior settled run defaults to valid, so there is no false-invalid flash on mount. This replaced the older "treat-as-invalid-while-validating" rule (spec §8.2 updated).

`debouncedValidator(fn, ms)` returns a validator whose Promise resolves after `ms` (or rejects with AbortError if the signal aborts first). Its return type is the precise `(v, s) => Promise<string | null>` rather than the widened `Validator<T>`, so a direct caller storing the result in a `string | null` signal type-checks. It stays assignable wherever a `Validator<T>` is expected (`field.ts:545-548`).

**A sync failure abandons the pass's async validators (1.0).** A pass runs every validator, sync and async together. When a sync one fails, the pass settles on its errors at once and does not wait for the async ones. `abandonAsyncResults` in `utils.ts` then aborts them and attaches a no-op handler to each promise. Without it, the rejection that the next pass or dispose caused was unhandled: clearing a field with `required` and a `debouncedValidator` logged an `AbortError`. The field, form and field-array runners share the helper. Pinned by `regressions.test.ts`, "an async validator abandoned by a failing sync one settles quietly".

## Form-level validators that target fields (T5.2)

A validator on `FormOptions.validators` or on `FieldArrayOptions.validators` may return a `FormIssue[]` instead of a `string`. `FormImpl.runTopLevelValidators` and `FieldArrayImpl.runTopLevelValidators` collect all results, sync and async, via `appendIssues`. They hand them to `routeFormIssues(this, issues, topLevelErrors$, lastTargets)` in `form.ts`:

- **empty-path** (and unresolvable) issues → the node's own `topLevelErrors$`.
- **path** issues → `resolveNode(this, path)` walks keys on a Form and numeric indices on a FieldArray to reach the target node, then calls its `setFormErrors(msgs)`.

Each node type (`FieldImpl`, `FormImpl`, `FieldArrayImpl`) exposes `setFormErrors`. On a Field it feeds `formErrors$`, which merges into `errors`. On a Form or FieldArray it feeds `parentFormErrors$`, which merges into that node's **`topLevelErrors`** getter, now a `computed` over its own errors plus the parent-injected ones, and is factored into `isValid`. `routeFormIssues` clears any target written last run but not this one, tracked in `lastFormErrorTargets`, so a fixed rule removes its message. The router runs inside the validator `effect`, but only *reads* the tracked form `value` and *writes* error signals, peeking elsewhere. It therefore adds no spurious dependencies and cannot loop, because errors are not part of `value`. Pinned by `regressions.test.ts` under R-F5.2. The Standard-Schema path from `validator(schema)` to `FormIssue[]` is pinned by `standard-schema.test.ts`.

## `Form.set(partial)` — batched deep merge

Iterate `Object.entries(partial)`. For each key, dispatch on the child:

- Form → child.set(val)
- FieldArray → `child.clear()`, then `child.add(item)` for each item
- Field → child.set(val)

All inside `batch(() => ...)` so subscribers see one notification.

## `FieldArray<I>` — dynamic children

`itemFactory: (initial?: ItemInitial<I>) => I` produces a new item. **The factory MUST consume the `initial` argument** or `add(x)` will silently ignore `x`. Canonical pattern:

```ts
createFieldArray(ctx, (initial) => createField(ctx, initial ?? ''))
createFieldArray(ctx, (initial) => createForm(ctx, schema, { initial }))
```

See `../pitfalls/fieldarray-factory-uses-initial.md`.

`remove(i)` calls `.dispose()` on the removed item (Field/Form/FieldArray all implement it). `clear()` disposes all items.

**Structural dirtiness (T5.1).** `FieldArray.isDirty` is `structurallyDirty$ || anyItemDirty`. `add`, `insert`, `remove`, `move` and `clear` flip the `structurallyDirty$` signal, and `reset()` and the `replaceInitialItems()` re-anchor clear it. Item-level dirtiness alone missed add, remove and move. A reactive `initial: () => queryData` under the default `resetOnInitialChange: 'when-clean'` then re-seated the array on a background refetch and deleted rows the user had just added; the guard is in `FormImpl` construction at `form.ts:99-124`. Construction seeds items directly rather than through `add()`, so a fresh array is clean. Pinned by `regressions.test.ts` (R-F5.1).

## What's NOT implemented yet

- `form.fieldAt('a.b.c')` path-typed lookup — spec §20.7 says this is "deferred to post-v1". Use `form.fields.a.fields.b.fields.c` chained access.

Reactive `initial` **is** implemented. This page's prior "not reactive between resets" note was bootstrap-era drift. An `initial: () => …` thunk runs in a tracking scope and re-applies when its tracked signals change, gated by `resetOnInitialChange`, whose values are `'when-clean'` by default, `'always'` and `'never'`. The `'when-clean'` guard consults `isDirty`, which now includes the structural FieldArray edits described above. Spec §8.4, §8.5.
