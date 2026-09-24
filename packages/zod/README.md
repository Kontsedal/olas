# @kontsedal/olas-zod

Zod to Olas forms adapter. Point a single `Field` at a schema with `zodValidator`, or with `zodValidatorAsync` for async refinements. Or infer a whole `Form` from a `z.object(...)` with `createZodForm`. Either way the schema is the one source of truth for both *shape* and *validation*.

Olas core stays Zod-free. This package has a peer dep on `zod ^4`.

## Install

```bash
pnpm add @kontsedal/olas-zod @kontsedal/olas-core zod
```

## 30-second example

### Single-field validator

```ts
import { createField, defineController } from '@kontsedal/olas-core'
import { zodValidator } from '@kontsedal/olas-zod'
import { z } from 'zod'

const signup = defineController((ctx) => ({
  email: createField<string>(ctx, '', { validators: [zodValidator(z.string().email())] }),
}))
```

The `<string>` matters: without it, TypeScript infers the literal `''` and the field accepts no other value.

### Whole form inferred from schema

<!-- snippet-prelude
declare function saveProfile(value: { name: string; age: number }): Promise<void>
-->
```ts
import { defineController } from '@kontsedal/olas-core'
import { createZodForm } from '@kontsedal/olas-zod'
import { z } from 'zod'

const schema = z.object({
  name: z.string().min(1),
  age: z.number().int().min(0),
  address: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
  }),
  tags: z.array(z.string().min(1)),
})

const profileForm = defineController((ctx) => {
  const form = createZodForm(ctx, schema, { initial: { name: 'Ada' } })

  // `form` is a signal of its value: form.value is z.infer<typeof schema>.
  const save = async () => {
    const result = await form.submit((value) => saveProfile(value))
    if (!result.ok) console.warn('not saved:', result.reason)
  }

  return { form, save }
})
```

`createZodForm` walks the schema:

- `z.object(...)` → `Form<...>` (recurses).
- `z.array(...)` → `FieldArray<...>` (recurses on element type).
- Anything else → `Field<...>` with `zodValidator(...)` attached.

Each leaf's initial value comes from the Zod schema's `.default(...)` if present, otherwise the empty value for the type (`''` for string, `0` for number, etc.). Override any of them with the `initial` option, a partial value. `initial` can also be a function that reads signals: the form re-seats when they change, while it is not dirty, as `createForm`'s tracked `initial` does. `resetOnInitialChange` picks the policy.

The return type follows the schema: `form.fields.address.fields.city` is a `Field<string>`, and `form.fields.tags` is a `FieldArray` of `Field<string>`. `form.submit(handler)` resolves a `SubmitResult`: `{ ok: true, data }` or `{ ok: false, reason }`, where `reason` is `'invalid'`, `'busy'`, `'disposed'` or `'error'` (the last with the `error`).

## API

```ts nocheck
function zodValidator<T>(schema: z.ZodType<T>): Validator<T>
function zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T>

function createZodForm<S extends z.ZodObject<z.ZodRawShape>>(
  ctx: Ctx,
  schema: S,
  options?: ZodFormOptions<S>,
): Form<{ [K in keyof S['shape']]: ZodToLeaf<S['shape'][K]> }>

type ZodFormOptions<S> = {
  initial?: DeepPartial<z.infer<S>> | (() => DeepPartial<z.infer<S>> | undefined)
  resetOnInitialChange?: 'when-clean' | 'never' | 'always'
  extraValidators?: Record<string, Validator<any>>   // keyed by dotted schema path
}
```

`zodValidator` wraps the schema through core's Standard Schema `validator(...)` and returns every issue with its path. On a leaf field those collapse to the messages. `zodValidatorAsync` awaits `.safeParseAsync(...)` for schemas with async `.refine` and `.transform`, and reports the first issue's message.

| Export | What |
|---|---|
| `zodValidator(schema)` | A `Validator<T>` for a single `Field`, or for a whole form, where each issue lands on the field its path names. |
| `zodValidatorAsync(schema)` | Async variant — awaits `safeParseAsync`, for schemas with async `.refine` / `.transform`. Aborts with the field's validation pass. |
| `createZodForm(ctx, schema, options?)` | Walks a `z.object(...)` into a matching `Form` / `Field` / `FieldArray` tree with validators auto-attached. |
| `rootOnlyZodValidator(schema)` | The form-level validator `createZodForm` attaches: it reports only the schema's root issues, which leaf validators cannot see. |

`ZodFormOptions`, `ZodToLeaf`, `UnwrapZod` and `ExtraValidators` are exported types.

`extraValidators` adds a rule to one leaf, next to its Zod check, by dotted schema path: `'title'`, `'address.street'`. An array adds no segment, so `'tags'` applies to every tag.

## Limitations

Leaf and nested-object rules walk correctly in every case. A root-level `.refine(...)` on the top `z.object(...)` becomes a form-level error in `form.topLevelErrors`. Two outer-schema rules are not lifted:

- **A root `.refine(..., { path })`** is dropped, rather than landing on the field its path names. Leave out `path`, and the message lands in `form.topLevelErrors`.
- **An array-level rule such as `z.array(...).min(3)`** is dropped, and `form.isValid` stays `true` with one item. Restate the rule as a root `.refine(...)` with no `path`, such as `.refine((v) => v.tags.length >= 3, 'Add at least three tags')`. Its message lands in `form.topLevelErrors`.

## Further reading

- [`../../API.md`](../../API.md#kontsedalolas-zod) — full reference.
- [`../../.wiki/modules/zod.md`](../../.wiki/modules/zod.md)
- [SPEC §8.7](../../SPEC.md#87-zod-integration-kontsedalolas-zod) for the Zod integration, and [§20.7](../../SPEC.md#207-fields-forms--validators) for the form types.
