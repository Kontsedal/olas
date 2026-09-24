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
| `rootOnlyZodValidator(schema)` | A form-level validator for a hand-built `createForm` whose leaves validate themselves. It reports only the schema's first issue with an empty path. `createZodForm` does not use it. |

`ZodFormOptions`, `ZodToLeaf`, `UnwrapZod` and `ExtraValidators` are exported types.

`extraValidators` adds a rule to one leaf, next to its Zod check, by dotted schema path: `'title'`, `'address.street'`. An array adds no segment, so `'tags'` applies to every tag.

## Rules on objects and arrays

A rule on a leaf, such as `z.string().min(8)`, runs on that leaf's field. A rule on an object or an array is enforced too, and its message lands on the node its path names:

| Rule in the schema | Where the message lands |
|---|---|
| `z.object({...}).refine(fn, message)`, with no `path` | `form.topLevelErrors` |
| `.refine(fn, { path: ['confirm'], message })` | `form.fields.confirm.errors` |
| `z.array(...).min(3, message)`, or a `.refine` on the array | that `FieldArray`'s `topLevelErrors` |
| a `.refine` on a nested `z.object(...)` | that nested form's `topLevelErrors` |

A path the form has no node for, such as a missing key, lands in `form.topLevelErrors`. The node reads invalid while its rule fails, and so does every form above it.

```ts
import { defineController } from '@kontsedal/olas-core'
import { createZodForm } from '@kontsedal/olas-zod'
import { z } from 'zod'

const signupSchema = z
  .object({
    password: z.string().min(8),
    confirm: z.string().min(1, 'Confirm your password'),
    tags: z.array(z.string().min(1)).min(3, 'Add at least three tags'),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords must match' })

const signup = defineController((ctx) => {
  const form = createZodForm(ctx, signupSchema, {
    initial: { password: 'correct horse', confirm: 'correct hose', tags: ['a'] },
  })
  form.fields.confirm.errors.value // ['Passwords must match']
  form.fields.tags.topLevelErrors.value // ['Add at least three tags']
  form.isValid.value // false
  return { form }
})
```

Each message appears once. With `confirm: ''`, the field shows `'Confirm your password'` from its own rule and `'Passwords must match'` from the refine. The whole-schema pass also sees the leaf's own failure, and drops it, because the leaf's validator already shows that message. An async rule such as `.refine(async (v) => …)` is awaited, and `form.isValidating` reads `true` until it settles.

**What it costs.** These rules need a parse of the whole schema, and that parse runs on every change to the form, beside the leaf validators. `createZodForm` installs it only when an object or an array in the schema carries a rule, including one on an `.optional()` or `.default()` wrapper around it. A schema with rules on its leaves alone gets no whole-schema parse: a change runs only the changed field's own validator.

## Further reading

- [`../../API.md`](../../API.md#kontsedalolas-zod) — full reference.
- [`../../.wiki/modules/zod.md`](../../.wiki/modules/zod.md)
- [SPEC §8.7](../../SPEC.md#87-zod-integration-kontsedalolas-zod) for the Zod integration, and [§20.7](../../SPEC.md#207-fields-forms--validators) for the form types.
