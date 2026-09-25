---
name: brand-markers-not-classes
description: Why runtime kinds are Symbol.for brand keys on plain objects instead of instanceof, and why the keys are symbols no public type exports.
type: decision
covers:
  - packages/core/src/brand.ts
  - packages/core/src/forms/form.ts:33-77
  - packages/core/src/query/define.ts
  - packages/core/src/query/mutation.ts:160-213
  - packages/core/src/scope.ts
edges:
  - { type: uses, target: ../modules/forms.md }
  - { type: tested-by, target: ../../packages/core/tests/scope.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/tree-shaking.test.ts }
last_verified: 2026-09-25
confidence: medium
---

# Brand markers, not classes

## The choice

Where core must tell kinds of value apart at runtime, the value carries a brand under a symbol key. `packages/core/src/brand.ts` holds three keys:

- **`BRAND`** — the kind, as a string: `'controller'`, `'query'`, `'infiniteQuery'`, `'queryEngine'`, `'scope'`, `'mutation'`. `olas-entities` stamps `'entity'` under the same key.
- **`PHANTOM`** — an optional property that pins a phantom type parameter (`Scope<T>`, `ControllerDef<Props, Api>`, `EntityDef<T>`). No value carries it at runtime.
- **`INTERNAL`** — plumbing a public value hands to core. Today that is the engine's `options` and `create`.

Forms keep their own two keys, `Symbol.for('olas.form')` and `Symbol.for('olas.fieldArray')` (`form.ts:33-77`), with the predicates `isForm` and `isFieldArray`. A node with neither brand is treated as a `Field`; no `isField` predicate exists.

Query dispatch reads the kind: `(query as { [BRAND]?: string })[BRAND] === 'infiniteQuery'` in `createQuery` (`query/bind.ts`).

## Why not `instanceof`?

### Impl classes aren't exported

`FormImpl`, `FieldArrayImpl` and `FieldImpl` are internal. Exposing them so consumers can use `instanceof` would couple every consumer to the internal class names. Brands decouple.

### `Symbol.for(...)` survives two copies of core

If two copies of `@kontsedal/olas-core` end up in a bundle, `instanceof` against a class from copy A fails on instances from copy B. `Symbol.for('olas.brand')` is the same symbol in both copies, so each recognizes the other's queries and scopes.

### Brands compose with mocks

A UI test can hand a component a fake form, `{ [Symbol.for('olas.form')]: true, fields: {...}, … }`. With `instanceof` it would need a real `FormImpl`, which means a real `ctx` and a real controller.

## Why symbol keys, not `__olas: 'query'`

Before 1.0 the kind was a string property, `__olas`, and the phantom types and engine plumbing sat beside it as `__t`, `__types`, `__options` and `__create`. They all showed in autocomplete on every public value, and in `Object.keys` and `JSON.stringify`.

A symbol key shows in none of those. Core does not export the three symbols, so user code cannot reach them by name. The published `.d.ts` declares each one as a non-exported `declare const BRAND: unique symbol`.

The old page argued for the string form because it "is nicer in error messages, devtools events, and grep output". None of those reads the brand: errors and devtools events carry the query's `id`.

`Scope` lost its `__id: symbol` in the same pass. The scope object is its own identity, so the instance's scope maps key on the object (`controller/instance.ts`).

## Non-enumerable where a value is spread

`defineMutation` sets its brand with `Object.defineProperty(..., { enumerable: false })` (`query/mutation.ts`). `createMutation(ctx, { ...def, retry: 0 })` is a supported spelling, and a spread must not carry the brand into the inline spec.

## What's NOT branded

`Field` has no brand of its own; it is inferred by elimination (`isField = !isForm && !isFieldArray`). A new schema-tree node type should add an explicit brand.
