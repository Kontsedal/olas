---
name: brand-markers-not-classes
description: Why we use Symbol.for(...) brands for runtime type discrimination instead of instanceof.
type: decision
covers:
  - packages/core/src/forms/form.ts
  - packages/core/src/query/define.ts
edges:
  - { type: uses, target: ../modules/forms.md }
last_verified: 2026-05-18
confidence: high
---

# Brand markers, not classes

## The choice

Where we need to distinguish primitive types at runtime, we use a brand marker on the impl object:

- `Form` and `FieldArray`: `Symbol.for('olas.form')` and `Symbol.for('olas.fieldArray')` (in `form.ts`).
- `Query` and `InfiniteQuery`: `__olas: 'query'` and `__olas: 'infiniteQuery'` (in `define.ts`).
- `ControllerDef`: `__olas: 'controller'` (in `define.ts`).

Predicates: `isForm(x)`, `isFieldArray(x)`, `isField(x)` (defaults when neither brand is set). Query dispatch: `(query as { __olas?: string }).__olas === 'infiniteQuery'`.

## Why not `instanceof`?

### Impl classes aren't exported

`FormImpl`, `FieldArrayImpl`, `FieldImpl` are internal. Exposing them so consumers can do `instanceof` would couple every consumer to the internal class names. Brands decouple.

### `Symbol.for(...)` survives bundling

If two copies of `@olas/core` end up in a bundle (a dependency upgrade gone wrong), `instanceof` against a class from copy A fails on instances from copy B. `Symbol.for('olas.form')` resolves to the same symbol across realms.

### Brands compose with mocks

In UI tests, you might want to hand a "fake form" to a component that calls `isForm(...)` on it. With brands, mocking is `{ [FORM_BRAND]: true, fields: {...}, value: signal({...}), ... }`. With `instanceof`, you'd have to construct a real `FormImpl`, which means a real `ctx`, which means a real controller — too much for a UI test.

## Why a literal `__olas: 'query'` for queries, not a Symbol?

Queries cross the network boundary in SSR (`dehydrate()` would NOT serialize the brand, but the brand is checked at runtime in `ctx.use`). Symbols don't serialize through `JSON.stringify`. We don't actually need cross-process equality for query brands — they're never sent over the wire — but the literal string form is also nicer in error messages, devtools events, and grep output.

For forms, the brand is on an object held in user memory only, so a `Symbol.for(...)` is fine and gives us the bundling-resilience property.

## Predicate locations

```ts
// form.ts:24-31
const isForm        = (x: unknown): x is Form<FormSchema>
const isFieldArray  = (x: unknown): x is FieldArray<...>
const isField       = (x: unknown): x is Field<unknown>

// controller/instance.ts:243 (in ctx.use)
const brand = (query as { __olas?: string }).__olas
```

## What's NOT branded

`Field` doesn't get its own brand; we infer it by elimination (`isField = !isForm && !isFieldArray`). Adding a `Symbol.for('olas.field')` brand would make the test ordering insensitive but wasn't needed in practice. A future contributor adding new schema-tree node types should add explicit brands.
