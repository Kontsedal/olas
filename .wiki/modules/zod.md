---
name: zod
description: "@kontsedal/olas-zod — zodValidator and formFromZod."
type: module
covers:
  - packages/zod/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/zod/tests/zod.test.ts }
  - { type: uses, target: forms.md }
last_verified: 2026-05-22
confidence: high
---

# `@kontsedal/olas-zod`

Four exports: `zodValidator(schema)`, `zodValidatorAsync(schema)`, `rootOnlyZodValidator(schema)`, and `formFromZod(ctx, schema, options?)`. Spec §8.7, §10.

## zodValidator / zodValidatorAsync

```ts
zodValidator<T>(schema: z.ZodType<T>): Validator<T>
zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T>
```

Wraps a Zod schema as an Olas `Validator`. Sync (`safeParse`) and async (`safeParseAsync`) variants. Returns the first issue's message, or `null` if valid.

## rootOnlyZodValidator

```ts
rootOnlyZodValidator<T>(schema: z.ZodType<T>): Validator<T>
```

Runs the schema and reports ONLY root-level issues (those with empty `path`) — leaf issues are dropped because each leaf already has its own `zodValidator(propSchema)`. Used by `formFromZod` to lift `z.object({...}).refine(fn)` rules into a form-level validator without double-reporting leaf failures.

## formFromZod

```ts
formFromZod<T extends z.ZodObject<...>>(
  ctx: Ctx,
  schema: T,
  options?: { initials?: Partial<z.infer<T>>; extraValidators?: Record<string, Validator<any>> }
): Form<{ [K in keyof T['shape']]: ZodToLeaf<T['shape'][K]> }>
```

Walks a `z.object` schema and builds the corresponding `Form` / `FieldArray` / `Field` tree with Zod validators auto-attached. Return type is structurally precise — no hand-written `Form<{...}>` shape required.

- `z.object(...)` → `Form` (recurse). The root form gets `rootOnlyZodValidator(rootSchema)` attached so top-level `.refine(...)` rules surface as form-level errors.
- `z.array(...)` → `FieldArray` (recurse on the element).
- anything else → `Field` with `zodValidator(schema)`.

`unwrap(schema)` strips outer `ZodDefault` / `ZodOptional` / `ZodNullable` wrappers (up to 5 deep) to find the inner type. Default initial is the Zod default if present, else the empty value for the type (`''` for string, `0` for number, `false` for bool, `[]` for array, first option for enum, `undefined` otherwise).

`extraValidators` is keyed by dotted leaf path (`'title'`, `'address.street'`). Each entry's validator is appended to that leaf's validators list alongside the Zod check — both must pass. `FieldArray` items aren't separately addressable (one factory per array).

What's still NOT lifted: array-level `.min(N)` from the outer Zod schema doesn't promote to a `FieldArray`-level validator (per-element rules already attach via the element schema).

## Peer dep contract

`peerDependencies: { @kontsedal/olas-core: workspace:^, zod: ^3.23.0 }`. The adapter is small (~2 kB); Zod itself is ~13 kB. Bundling Zod into core would force the cost on every consumer — see `decisions/zod-as-adapter.md` (TODO if/when raised).
