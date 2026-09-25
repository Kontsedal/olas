---
name: zod-schema-rules
description: Why createZodForm enforces object and array rules with one whole-schema validator that drops what a leaf already shows, and installs it only when the schema has such a rule.
type: decision
covers:
  - packages/zod/src/index.ts:170-304
  - packages/zod/src/index.ts:522-539
edges:
  - { type: uses, target: ../modules/zod.md }
  - { type: uses, target: ../modules/forms.md }
  - { type: tested-by, target: ../../packages/zod/tests/zod.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-09-25
confidence: medium
---

# Rules on objects and arrays in `createZodForm`

## The problem

Before 1.0, `createZodForm` gave the root form `rootOnlyZodValidator(schema)`. That validator parsed the whole schema on every change and kept only the issues with an empty path. So a form read valid while its schema rejected the value, in three cases:

- a root `.refine(fn, { path: ['confirm'] })`, whose issue has the path `['confirm']`;
- an array-level rule, `z.array(...).min(3)`, whose issue has the path `['tags']`;
- a `.refine` on a nested object, because only the root form had a validator.

The parse also ran for a schema with no such rule, where it could find nothing the leaf validators had not.

## What it does now

Each leaf field keeps its own `zodValidator(leafSchema)`. `hasStructuralRules` (`packages/zod/src/index.ts:192-209`) walks the objects and arrays of the schema, with their `.optional()`, `.nullable()` and `.default()` wrappers, and looks for a non-empty `def.checks`. Only then does the root form get `schemaRulesValidator` (`packages/zod/src/index.ts:296-304`, installed by `hasStructuralRules(rootSchema)` at `:528-529`).

That validator parses the whole schema through core's Standard Schema `validator`. `unownedIssues` (`packages/zod/src/index.ts:259-280`) sorts each issue with `leafAlong` (`:218-246`), which walks the schema and the value together:

- A path that ends at a `Form` or a `FieldArray`, or names a key the schema lacks, keeps its path. Core's router (`routeFormIssues`, `packages/core/src/forms/form.ts:159-199`) puts it in that node's `topLevelErrors`, or in the root's when nothing resolves.
- A path at or under a leaf is cut to the leaf's path. It is dropped when the leaf's own schema reports the same message for the leaf's value. Otherwise it lands on the field, in the channel core keeps for form-level messages.

## Why one validator at the root

The alternative was a validator on each node that owns a rule: a `FieldArrayValidator` for an array's `.min(3)`, and a form-level validator on each refined object. It would parse overlapping subtrees, since the root's parse contains the array's. A root refine with a path still needs the leaf filter. And a root validator installed for a root refine would report the array's `.min(3)` a second time, beside the array's own validator. One whole-schema parse at the root, routed by path, gives each issue exactly one owner, and core's router already reaches every node.

## Why ownership is decided by re-running the leaf

A path alone cannot tell a leaf's own failure from a root refine that targets the leaf, since both carry `['confirm']`. The BACKLOG sketch was to keep only `code: 'custom'` issues. That fails three ways. A leaf's own `.refine` is also `custom`, so it would report twice. An array's `.min(3)` is `too_small`, so it would be dropped. And `.superRefine` can add an issue with any code.

Re-running the leaf's schema on the leaf's value gives exactly the messages its field shows, because the leaf validator runs the same schema. The re-run happens once for each issue the whole-schema parse reported at a leaf, so a valid form re-parses nothing. A per-leaf cache would save a second parse when one leaf has two issues, and it cost more bundle bytes than that saves. The comparison is by message, so a root rule whose text equals the leaf's own message is dropped as well. The field would show the same text twice otherwise.

## Why the whole-schema parse is conditional

It runs on every change to any field, because a form-level validator tracks the whole form value. A schema with rules on its leaves alone gets nothing from it. `zod.test.ts` pins both sides with a spy on the root schema's `_zod.run`, the entry of every Zod parse.

## Rejected: one whole-form validator and no leaf validators

The BACKLOG's other option was to drop the per-leaf validators and route every issue from the one parse. That puts a whole-schema parse on every keystroke of every form, including plain ones. It also loses the per-field async state a leaf validator has: each field's own `isValidating` and its supersede-on-change.

## Rejected: a shadow schema with `z.unknown()` leaves

Parsing a copy of the schema with each leaf swapped for `z.unknown()` would report only the object and array rules, with no filter. But a refine would then see the raw input instead of a leaf's transformed output. It would also run on a value a leaf rejects: Zod skips an object's refine after a child's `invalid_type`, and the copy would not. The copy would need Zod internals to rebuild each object and array with its checks.

## Known edges

- A no-op `field.reset()` clears a routed message, and the form does not re-run until the next change. That is core's, and `BACKLOG.md` has it under "A no-op field reset can hide a form-level error".
- `def.checks` is Zod 4's own record of a schema's rules. The package already reads `def.innerType` and `def.defaultValue` the same way.
