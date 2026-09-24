---
name: literal-type-narrowing
description: createField infers T from its initial value. With validators the literal sticks (Field<''>), and null or [] give a field that holds only that. Annotate the type parameter.
type: pitfall
covers:
  - packages/core/src/forms/bind.ts:31
  - packages/core/src/forms/validators.ts:66-69
  - packages/core/src/controller/types.ts:37-47
edges:
  - { type: tested-by, target: ../../packages/core/tests/type-pitfalls.test-d.ts }
last_verified: 2026-09-25
confidence: high
---

# `createField` infers `T` from the initial value: annotate it

`createField<T>(ctx, initial: T, options?: FieldOptions<T>): Field<T>` (`packages/core/src/forms/bind.ts:31`) infers `T` from `initial`. What it infers depends on the call:

```ts nocheck
createField(ctx, '')                                         // Field<string>   fine
createField(ctx, '', { validators: [required(), email()] })  // Field<''>       set('a@b.c') is an error
createField(ctx, null)                                       // Field<null>     set('x') is an error
createField(ctx, [])                                         // Field<never[]>  set(['x']) is an error
createField(ctx, 'light')                                    // Field<string>   the union is lost
```

## Why the validators case keeps the literal

With no other inference site, TypeScript widens a literal argument, so `''` becomes `string`. A `validators` array gives `T` a second, contravariant site: `required` is generic (`<T>(message?) => Validator<T>`, `validators.ts:66-69`), and `email()` is a `Validator<string>`. The initial value gives a covariant candidate, `''`, and the validator a contravariant one, `string`. With both, TypeScript picks the covariant literal. The field then accepts only `''`.

The first compiler error shows at the first `set(...)` with a real value, often far from the declaration.

## The fix

Annotate the type parameter whenever the initial value is narrower than what the field holds:

```ts nocheck
const address = createField<string>(ctx, '', { validators: [required(), email()] })
const note = createField<string | null>(ctx, null)
const tags = createField<string[]>(ctx, [])
const theme = createField<'light' | 'dark'>(ctx, 'light')
```

The same holds one level up, in a `createForm` schema: the form's value type is built from its leaves' `T`s.

## History

Until the W6 docs pass (2026-09-25), this page and CLAUDE.md said a bare `createField(ctx, '')` infers `Field<''>`. It does not. The type test that claimed to pin it asserted `expectTypeOf(value).toMatchTypeOf<string>()`, which `''` and `string` both satisfy, and `expectTypeOf(x)` widens a literal as it infers its type argument in any case. `packages/core/tests/type-pitfalls.test-d.ts` now pins all three behaviours with `expectTypeOf<typeof x>()`. The wrong claim had led the repo's tests and docs to annotate every `createField<string>(ctx, '')`. That annotation is harmless, and it is needed as soon as validators are added.
