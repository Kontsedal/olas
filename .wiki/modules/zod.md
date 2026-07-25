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
last_verified: 2026-07-25
confidence: high
---

# `@kontsedal/olas-zod`

Four exports: `zodValidator(schema)`, `zodValidatorAsync(schema)`, `rootOnlyZodValidator(schema)`, and `formFromZod(ctx, schema, options?)`. Spec §8.7, §10.

## zodValidator / zodValidatorAsync

```ts
zodValidator<T>(schema: z.ZodType<T>): Validator<T>
zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T>
```

Wraps a Zod schema as an Olas `Validator`. `zodValidator` is now a thin alias over `validator(...)` from core (Zod 4 implements Standard Schema), so it returns **all** issues as `FormIssue[]` — each carrying its `path` (T5.2). As a leaf field validator the paths are empty and collapse to messages; as a whole-object form-level validator the paths route each issue onto the matching field. `zodValidatorAsync` still returns the **first** issue message as a `string | null` (it doesn't preserve paths). T6.5 fixed its abort-race: the `abort` listener is removed in a `finally` and the losing race promise's rejection is swallowed with a `.catch`, so a validation that completes before a later `abort()` no longer leaks the listener or triggers an unhandled rejection.

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
- anything else → `Field` with `zodValidator(schema)`. A nested leaf that *looks* like a zod schema (has a `def`/`_def`) but fails every `instanceof` check — i.e. a **duplicate zod copy** — can't be introspected, so it degrades to a flat field; `formFromZod` dev-warns via `isForeignZod` / `warnDuplicateZod` (T6.5).

`unwrap(schema)` strips outer `ZodDefault` / `ZodOptional` / `ZodNullable` wrappers (up to 5 deep) to find the inner type. Default initial is the Zod default if present, else the empty value for the type: `''` string, `0` number, `false` bool, `[]` array/tuple, first option for enum, `0n` bigint, `{}` record, `undefined` otherwise. **`ZodDate` → `undefined`** (T6.5 — the old `null` flowed a non-Date into a `Date`-typed field; pair with `required()` for "must pick a date"). A **`.transform()` / `.pipe()`** (`ZodPipe`) seeds from its INPUT schema's default via `def.in` — the field holds what the user edits, and the transform runs on parse; note the field TYPE still reflects `z.infer` (the output), a documented mismatch (T6.5).

`extraValidators` is keyed by dotted leaf path (`'title'`, `'address.street'`). Each entry's validator is appended to that leaf's validators list alongside the Zod check — both must pass. `FieldArray` items aren't separately addressable (one factory per array).

What's still NOT lifted: array-level `.min(N)` from the outer Zod schema doesn't promote to a `FieldArray`-level validator (per-element rules already attach via the element schema). Also, `rootOnlyZodValidator` still keeps only **empty-path** refine issues — a `z.object({...}).refine(fn, { path: ['confirm'] })` is dropped rather than routed onto `confirm`, even though core's `validator()` now preserves paths. Routing those cleanly (without double-reporting leaf issues) is a `BACKLOG.md` item.

## Peer dep contract

`peerDependencies: { @kontsedal/olas-core: workspace:^, zod: ^4.0.0 }` (Zod 4 only — it implements Standard Schema, which `zodValidator` relies on). The adapter is small (~2 kB); Zod itself is ~13 kB. Bundling Zod into core would force the cost on every consumer — see `decisions/zod-as-adapter.md` (TODO if/when raised).
