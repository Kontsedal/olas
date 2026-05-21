---
name: fieldarray-factory-uses-initial
description: FieldArray.add(x) only does something useful if the factory uses its `initial` argument.
type: pitfall
covers:
  - packages/core/src/forms/form.ts:388-510
edges:
  - { type: tested-by, target: ../../packages/core/tests/form.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: uses, target: ../modules/forms.md }
last_verified: 2026-05-21
confidence: high
---

# `FieldArray.add(x)` requires the factory to USE `x`

## The trap

Spec §8.5 example reads naturally:

```ts
const tags = ctx.fieldArray(() => ctx.field('', [required()]))
tags.add('hello')
tags.value.value   // string[]
```

If you write the factory as `() => ctx.field('')`, the factory ignores its `initial` parameter — every `add(x)` call creates a field initialized to `''`, regardless of `x`. The array's `value` ends up `['', '', '']`, not `['hello', 'world', ...]`.

`FieldArrayImpl.add(initial)` calls `this.itemFactory(initial)` and trusts the factory to use the argument:

```ts
add(initial?: ItemInitial<I>): void {
  if (this.disposed) return
  const item = this.itemFactory(initial)   # FACTORY decides what to do with `initial`
  this.items$.set([...this.items$.peek(), item])
}
```

There's no auto-set fallback — by design, because:
- For Form items, "use initial" means `ctx.form(schema, { initial })`, not `form.set(initial)`.
- For Field items with validators, the user might want to construct with the initial AND a different set of validators per item.

## The fix in user code

Canonical patterns:

```ts
ctx.fieldArray((initial) => ctx.field(initial ?? ''))                   # field
ctx.fieldArray((initial) => ctx.form(schema, { initial }))              # form
ctx.fieldArray((initial: { sku?: string }) =>                           # form with typed initial
  ctx.form({ sku: ctx.field<string>('', [required()]) }, { initial }))
```

## The bug we hit

Phase 8 test `add/remove/insert/move/clear` initially used `() => ctx.field('')`. Every `add('a')`, `add('b')`, `add('c')` produced an empty-string field; the test expected `['a', 'b', 'c']` but got `['', '', '']`.

Fix: use `initial` in the factory:

```ts
tags: ctx.fieldArray((initial) => ctx.field(initial ?? '')),
```

The spec's own example (cited above) is misleading about this — it shows the factory ignoring `initial` but expects the values to land anyway. The implementation deliberately doesn't auto-set; the test we wrote reflects what the code actually does.

## Diagnostic

If `fieldArray.value.value` doesn't reflect what you passed to `add(...)`, check the factory. Symptoms:

- `add('hello')` then `value.value === ['']` (empty).
- `add({ sku: 'A' })` then `value.value === [{ sku: '', qty: 1 }]`.

In both cases, the factory wasn't threading `initial` through to the leaf primitive.

## Where this is verified

`packages/core/tests/form.test.ts > ctx.fieldArray > add/remove/insert/move/clear` and `> arrays of sub-forms aggregate value/errors`. Both use the `(initial) => ctx.field(initial ?? '')` pattern.
