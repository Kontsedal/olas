---
name: zod
description: "@olas/zod — zodValidator and formFromZod."
type: module
covers:
  - packages/zod/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/zod/tests/zod.test.ts }
  - { type: uses, target: forms.md }
last_verified: 2026-05-18
confidence: high
---

# `@olas/zod`

Two exports: `zodValidator(schema)` and `formFromZod(ctx, schema, options?)`. Plus `zodValidatorAsync` for `.refine(async ...)` schemas. Spec §8.7, §10.

## zodValidator

```ts
zodValidator<T>(schema: z.ZodType<T>): Validator<T>
```

Wraps a Zod schema as an Olas `Validator`. Synchronous (`safeParse`). Returns the first issue's message, or `null` if valid. `zodValidatorAsync` is the `safeParseAsync` variant.

## formFromZod

Walks a `z.object` schema and builds the corresponding `Form` / `FieldArray` / `Field` tree with Zod validators auto-attached.

- `z.object(...)` → `Form` (recurse).
- `z.array(...)` → `FieldArray` (recurse on the element).
- anything else → `Field` with `zodValidator(schema)`.

`unwrap(schema)` strips outer `ZodDefault` / `ZodOptional` / `ZodNullable` wrappers (up to 5 deep) to find the inner type for `defaultInitial(...)` and recursion. The default initial is the Zod default if present, else the empty value for the type (`''` for string, `0` for number, `false` for bool, `[]` for array, first option for enum, `undefined` otherwise).

The Phase 9 implementation **does not** yet collect top-level `z.object().refine(...)` into form-level validators. The hook is in `buildForm` (commented). Spec §8.7 calls this out; implementation can land when needed.

## Peer dep contract

`peerDependencies: { @olas/core: workspace:^, zod: ^3.23.0 }`. The adapter is small (~2 kB); Zod itself is ~13 kB. Bundling Zod into core would force the cost on every consumer — see `decisions/zod-as-adapter.md` (TODO if/when raised).
