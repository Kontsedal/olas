---
name: zod
description: "@kontsedal/olas-zod — zodValidator and createZodForm."
type: module
covers:
  - packages/zod/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/zod/tests/zod.test.ts }
  - { type: tested-by, target: ../../packages/zod/tests/coverage-zod-edges.test.ts }
  - { type: uses, target: forms.md }
  - { type: related, target: ../decisions/zod-schema-rules.md }
last_verified: 2026-09-25
confidence: high
---

# `@kontsedal/olas-zod`

## What an `extraValidators` path means (0.9 review)

A path names a position in the SCHEMA, not in the value, and an array contributes no segment to it. So `'tags'` on `z.array(z.string())` attaches to EVERY tag field, and `'tags.name'` on `z.array(z.object({ name }))` attaches to every item's `name`. No path addresses the `FieldArray` itself. An array-level rule belongs in the schema instead, as `z.array(...).min(3)` or a `.refine` on the array, and lands in the array's `topLevelErrors` (see "Rules on objects and arrays" below). `zod.test.ts` pins the element behavior.

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

Runs the schema and reports its first root-level issue, one with an empty `path`, as a string. Every issue with a path is dropped, because each leaf is assumed to carry its own validator. It uses `safeParse`, so an async schema throws. `createZodForm` used it until 1.0 and no longer does; it stays exported for a hand-built `createForm` whose leaves validate themselves. `zod.test.ts` tests it directly.

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

- `z.object(...)` → `Form` (recurse). The root form gets `schemaRulesValidator(rootSchema)` only when the schema has a rule on an object or an array; see below.
- `z.array(...)` → `FieldArray` (recurse on the element).
- A `.default(...)` on an object or an array seeds that `Form` or `FieldArray` as a whole when the caller's `initial` has no value for the key, as `schema.parse({})` fills it. `buildLeaf` reads it through `zodDefault`, the lookup `defaultInitial` uses for leaves, so a default under `.optional()` or `.nullable()` counts too. Before this, only leaf defaults were read: `z.array(z.string()).default(['inbox'])` started as `[]`, and `z.object({ city }).default({ city: 'Kyiv' })` as `{ city: '' }`. Pinned by `zod.test.ts`, "a default on an array or an object seeds the FieldArray or the nested Form".
- anything else → `Field` with `zodValidator(schema)`. A nested leaf can *look* like a zod schema, carrying a `def` or `_def`, and still fail every `instanceof` check. That is a **duplicate zod copy**, which cannot be introspected, so it degrades to a flat field. `createZodForm` warns through `isForeignZod` and `warnDuplicateZod` (T6.5). The warning fires once per module (`warnedDuplicateZod`, `packages/zod/src/index.ts:95-110`), however many foreign leaves and forms there are. Each test file gets its own module, and within one file the first foreign schema uses the warning up, so `coverage-zod-edges.test.ts` runs its no-warning test first.

`unwrap(schema)` strips outer `ZodDefault`, `ZodOptional` and `ZodNullable` wrappers to a fixed point, one layer at a time through `unwrapOnce`, to find the inner type. The default initial is the Zod default when present, and otherwise the empty value for the type: `''` for string, `0` for number, `false` for boolean, `[]` for array and tuple, the first option for an enum, `0n` for bigint, `{}` for record, and `undefined` otherwise. **`ZodDate` maps to `undefined`** since T6.5. The old `null` flowed a non-Date into a `Date`-typed field. Pair it with `required()` for "must pick a date". A **`.transform()` and `.pipe()`** (`ZodPipe`) seeds from its INPUT schema's default via `def.in` — the field holds what the user edits, and the transform runs on parse; note the field TYPE still reflects `z.infer` (the output), a documented mismatch (T6.5).

`extraValidators` is keyed by dotted leaf path (`'title'`, `'address.street'`). Each entry's validator is appended to that leaf's validators list alongside the Zod check — both must pass. `FieldArray` items aren't separately addressable (one factory per array).

## Rules on objects and arrays (1.0)

A leaf's rules run in its own `zodValidator`. A rule on an object or an array is a non-empty `def.checks` on that schema or on an `.optional()`, `.nullable()` or `.default()` wrapper around it. `hasStructuralRules` (`packages/zod/src/index.ts:192-209`) looks for one, and only then does the root form get `schemaRulesValidator` (`:296-304`, installed by `hasStructuralRules(rootSchema)` at `:528-529`). It parses the whole schema through core's `validator`, and `unownedIssues` (`:259-280`) sorts each issue with `leafAlong` (`:218-246`):

| Issue path | Where it lands |
|---|---|
| empty | `form.topLevelErrors` |
| ends at a nested `Form` | that form's `topLevelErrors` |
| ends at a `FieldArray`, as from `.min(3)` | that array's `topLevelErrors` |
| at or under a leaf | that field, cut to the leaf's path, unless the leaf's own schema reports the same message |
| names a key the schema lacks | `form.topLevelErrors`, through core's fallback |

The leaf check re-runs the leaf's schema on the leaf's value, once for each issue the parse reported at that leaf. A root refine is async-safe: the parse goes through Standard Schema, which returns a promise for an async schema. The old `safeParse` threw `$ZodAsyncError` on one. The design, and the options rejected, are in `decisions/zod-schema-rules.md`.

The routing is core's (`packages/core/src/forms/form.ts:159-188`): a routed message sits in a field's form-errors channel, or in a `Form`'s or `FieldArray`'s `parentFormErrors$`. A no-op `field.reset()` clears it until the next change, which is a core `BACKLOG.md` item.

`zod.test.ts` pins each row, both documented examples, the recursive-schema walk, the async paths, and the cost. For the cost it spies on the root schema's `_zod.run`: a plain schema's is not called, and a refined one's runs once per change.

## Peer dep contract

`peerDependencies: { @kontsedal/olas-core: workspace:^, zod: ^4.0.0 }` (Zod 4 only — it implements Standard Schema, which `zodValidator` relies on). The adapter is 1.71 kB brotli in 1.0, up from 1.29 kB before the whole-schema validator; `.size-limit.json` holds it to 1.8 kB. Zod itself is ~13 kB. Bundling Zod into core would force the cost on every consumer — see `decisions/zod-as-adapter.md` (TODO if/when raised).
