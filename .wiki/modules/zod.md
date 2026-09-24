---
name: zod
description: "@kontsedal/olas-zod — zodValidator and createZodForm."
type: module
covers:
  - packages/zod/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/zod/tests/zod.test.ts }
  - { type: uses, target: forms.md }
last_verified: 2026-09-21
confidence: high
---

# `@kontsedal/olas-zod`

## What an `extraValidators` path means (0.9 review)

A path names a position in the SCHEMA, not in the value, and an array contributes no segment to it. So `'tags'` on `z.array(z.string())` attaches to EVERY tag field, and `'tags.name'` on `z.array(z.object({ name }))` attaches to every item's `name`. No path addresses the `FieldArray` itself: an array-level rule takes a `FieldArrayValidator` over the whole item list, a different signature that `createZodForm` does not wire. An array-level rule in the schema (`z.array(...).min(3)`) is not enforced either: its issue carries the path `['tags']`, and `rootOnlyZodValidator` keeps only path-less issues, so `form.isValid` stays `true` with one tag. The W6 docs pass found this by running it; the source comment had claimed `zodValidator` enforced it on the parent. A root `.refine(...)` with no `path` is the way to state such a rule. `zod.test.ts` pins the element behavior.

Four exports: `zodValidator(schema)`, `zodValidatorAsync(schema)`, `rootOnlyZodValidator(schema)`, and `createZodForm(ctx, schema, options?)`. Spec §8.7, §10.

## zodValidator / zodValidatorAsync

```ts
zodValidator<T>(schema: z.ZodType<T>): Validator<T>
zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T>
```

Wraps a Zod schema as an Olas `Validator`. `zodValidator` is now a thin alias over `validator(...)` from core, because Zod 4 implements Standard Schema. It returns **all** issues as `FormIssue[]`, each carrying its `path` (T5.2). As a leaf field validator the paths are empty and collapse to messages. As a whole-object form-level validator the paths route each issue onto the matching field. `zodValidatorAsync` still returns the **first** issue message as a `string | null` (it doesn't preserve paths). T6.5 fixed its abort-race: the `abort` listener is removed in a `finally` and the losing race promise's rejection is swallowed with a `.catch`, so a validation that completes before a later `abort()` no longer leaks the listener or triggers an unhandled rejection.

## rootOnlyZodValidator

```ts
rootOnlyZodValidator<T>(schema: z.ZodType<T>): Validator<T>
```

Runs the schema and reports ONLY root-level issues (those with empty `path`) — leaf issues are dropped because each leaf already has its own `zodValidator(propSchema)`. Used by `createZodForm` to lift `z.object({...}).refine(fn)` rules into a form-level validator without double-reporting leaf failures.

## createZodForm

```ts
createZodForm<T extends z.ZodObject<...>>(
  ctx: Ctx,
  schema: T,
  options?: {
    initial?: DeepPartial<z.infer<T>> | (() => DeepPartial<z.infer<T>> | undefined)
    resetOnInitialChange?: 'when-clean' | 'never' | 'always'
    extraValidators?: Record<string, Validator<any>>
  },
): Form<{ [K in keyof T['shape']]: ZodToLeaf<T['shape'][K]> }>
```

A function `initial` is tracked: the form re-seats when its signals change, as `createForm`'s does (1.0).

Walks a `z.object` schema and builds the corresponding `Form`, `FieldArray` and `Field` tree with Zod validators auto-attached. Return type is structurally precise — no hand-written `Form<{...}>` shape required.

- `z.object(...)` → `Form` (recurse). The root form gets `rootOnlyZodValidator(rootSchema)` attached so top-level `.refine(...)` rules surface as form-level errors.
- `z.array(...)` → `FieldArray` (recurse on the element).
- anything else → `Field` with `zodValidator(schema)`. A nested leaf can *look* like a zod schema, carrying a `def` or `_def`, and still fail every `instanceof` check. That is a **duplicate zod copy**, which cannot be introspected, so it degrades to a flat field. `createZodForm` dev-warns through `isForeignZod` and `warnDuplicateZod` (T6.5).

`unwrap(schema)` strips outer `ZodDefault`, `ZodOptional` and `ZodNullable` wrappers (up to 5 deep) to find the inner type. The default initial is the Zod default when present, and otherwise the empty value for the type: `''` for string, `0` for number, `false` for boolean, `[]` for array and tuple, the first option for an enum, `0n` for bigint, `{}` for record, and `undefined` otherwise. **`ZodDate` maps to `undefined`** since T6.5. The old `null` flowed a non-Date into a `Date`-typed field. Pair it with `required()` for "must pick a date". A **`.transform()` and `.pipe()`** (`ZodPipe`) seeds from its INPUT schema's default via `def.in` — the field holds what the user edits, and the transform runs on parse; note the field TYPE still reflects `z.infer` (the output), a documented mismatch (T6.5).

`extraValidators` is keyed by dotted leaf path (`'title'`, `'address.street'`). Each entry's validator is appended to that leaf's validators list alongside the Zod check — both must pass. `FieldArray` items aren't separately addressable (one factory per array).

What's still NOT lifted: array-level `.min(N)` from the outer Zod schema doesn't promote to a `FieldArray`-level validator (per-element rules already attach via the element schema). Also, `rootOnlyZodValidator` still keeps only **empty-path** refine issues — a `z.object({...}).refine(fn, { path: ['confirm'] })` is dropped rather than routed onto `confirm`, even though core's `validator()` now preserves paths. Routing those cleanly (without double-reporting leaf issues) is a `BACKLOG.md` item.

## Peer dep contract

`peerDependencies: { @kontsedal/olas-core: workspace:^, zod: ^4.0.0 }` (Zod 4 only — it implements Standard Schema, which `zodValidator` relies on). The adapter is small (~2 kB); Zod itself is ~13 kB. Bundling Zod into core would force the cost on every consumer — see `decisions/zod-as-adapter.md` (TODO if/when raised).
