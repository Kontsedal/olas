---
name: forms-are-read-signals
description: Why Form and FieldArray are ReadSignals of their value, like Field, so `.value` means the same thing on every form node.
type: decision
covers:
  - packages/core/src/controller/types.ts:38
  - packages/core/src/forms/form-types.ts:138-303
  - packages/core/src/forms/form.ts:313-435
  - packages/core/src/forms/form.ts:938-1093
edges:
  - { type: tested-by, target: ../../packages/core/tests/form.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/form-submit.test.ts }
  - { type: uses, target: ../modules/forms.md }
last_verified: 2026-09-25
confidence: medium
---

# Every form node is a `ReadSignal` of its value

## The decision

`Field<T>`, `Form<S>` and `FieldArray<I>` are all `ReadSignal`s of their value (`packages/core/src/controller/types.ts:38`, `packages/core/src/forms/form-types.ts:176` and `form-types.ts:270`):

```ts
field.value            // T
form.value             // FormValue<S>
array.value            // FieldArrayValue<I>
useValue(form)         // re-renders when any leaf changes
form.subscribe(fn)     // same
```

The three node kinds also share `set` and `setAsInitial`, each taking its own value shape. `Form.resetWithInitial` was renamed `setAsInitial`, and `FieldArray` gained both methods (`packages/core/src/forms/form.ts:1066-1093`).

## Why

Before 1.0, `Form.value` and `FieldArray.value` were `ReadSignal`s, while `Field.value` was the value itself. So `form.value.value` read a form, and `field.value` read a field. That was the documented pitfall `pitfalls/field-value-shape.md`, now deleted. It bit twice:
- **Traversal code.** The first `Form.computeValue` read `child.value.value` for every child and got `undefined` for each `Field`. The fix was a branch on the brand at every site.
- **Consumers.** `use(form.value)` and `use(field)` were two spellings of one intent.

The old reason for the asymmetry was that a form-level `subscribe` "would fire on every leaf change, which is rarely what you want". That was never a real cost. `form.value.subscribe` already fired on every leaf change, and moving the signal onto the node changes where the subscription is spelled, not when it fires.

## What it bought

- `computeValue` reads `(child as ReadSignal<unknown>).value` for every child, with no brand branch (`packages/core/src/forms/form.ts:367-374`). `FieldArrayImpl`'s aggregate does the same.
- `applyPartial` calls `set` or `setAsInitial` on any child. The array branch, with its cast to reach the internal `replaceInitialItems`, moved into `FieldArrayImpl.set` / `setAsInitial`.
- Brands are still needed wherever the node kinds differ: errors, touched, validation, path resolution.

## `submit` resolves a union

The same pass made `Form.submit` resolve a `SubmitResult<R>` (`packages/core/src/forms/form-types.ts:145-148`). `ok: true` carries `data`. `ok: false` carries a `reason`: `'invalid'`, `'error'` (with `error`), `'busy'` or `'disposed'`. Before, `{ ok: boolean; data?; error? }` could not tell "invalid" from "already submitting" without matching an error message.
