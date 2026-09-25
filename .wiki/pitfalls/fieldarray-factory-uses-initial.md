---
name: fieldarray-factory-uses-initial
description: FieldArray.add(x) only does something useful if the factory uses its `initial` argument.
type: pitfall
covers:
  - packages/core/src/forms/form.ts:923-935
  - packages/core/src/forms/form.ts:1018-1032
edges:
  - { type: tested-by, target: ../../packages/core/tests/form.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: uses, target: ../modules/forms.md }
last_verified: 2026-09-25
confidence: high
---

# `FieldArray.add(x)` requires the factory to USE `x`

## The trap

Spec §8.5 example reads naturally:

```ts
const tags = createFieldArray(ctx, () => createField(ctx, '', { validators: [required()] }))
tags.add('hello')
tags.value         // string[]
```

If you write the factory as `() => createField(ctx, '')`, the factory ignores its `initial` parameter — every `add(x)` call creates a field initialized to `''`, regardless of `x`. The array's `value` ends up `['', '', '']`, not `['hello', 'world', ...]`.

`FieldArrayImpl.add(initial)` calls `this.itemFactory(initial)` and trusts the factory to use the argument:

```ts
add(initial?: ItemInitial<I>): void {
  if (this.disposed) return
  const item = this.itemFactory(initial)   # FACTORY decides what to do with `initial`
  this.items$.set([...this.items$.peek(), item])
}
```

There's no auto-set fallback — by design, because:
- For Form items, "use initial" means `createForm(ctx, schema, { initial })`, not `form.set(initial)`.
- For Field items with validators, the user might want to construct with the initial AND a different set of validators per item.

## The fix in user code

Canonical patterns:

```ts
createFieldArray(ctx, (initial) => createField(ctx, initial ?? ''))                   # field
createFieldArray(ctx, (initial) => createForm(ctx, schema, { initial }))              # form
createFieldArray(ctx, (initial: { sku?: string }) =>                           # form with typed initial
  createForm(ctx, { sku: createField<string>(ctx, '', { validators: [required()] }) }, { initial }))
```

## The bug we hit

Phase 8 test `add/remove/insert/move/clear` initially used `() => createField(ctx, '')`. Every `add('a')`, `add('b')`, `add('c')` produced an empty-string field; the test expected `['a', 'b', 'c']` but got `['', '', '']`.

Fix: use `initial` in the factory:

```ts
tags: createFieldArray(ctx, (initial) => createField(ctx, initial ?? '')),
```

The spec's own example (cited above) is misleading about this — it shows the factory ignoring `initial` but expects the values to land anyway. The implementation deliberately doesn't auto-set; the test we wrote reflects what the code does.

## Diagnostic

If `fieldArray.value` doesn't reflect what you passed to `add(...)`, check the factory. Symptoms:

- `add('hello')` then `value === ['']` (empty).
- `add({ sku: 'A' })` then `value === [{ sku: '', qty: 1 }]`.

In both cases, the factory wasn't threading `initial` through to the leaf primitive.

## Where this is verified

`packages/core/tests/form.test.ts > ctx.fieldArray > add/remove/insert/move/clear` and `> arrays of sub-forms aggregate value/errors`. Both use the `(initial) => createField(ctx, initial ?? '')` pattern.
