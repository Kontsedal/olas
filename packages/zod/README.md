# @kontsedal/olas-zod

Zod ↔ Olas forms adapter. Two helpers — `zodValidator` (single field) and `formFromZod` (whole form, inferred from schema).

Olas core stays Zod-free. This package has a peer dep on `zod ^4`.

## Install

```bash
pnpm add @kontsedal/olas-zod @kontsedal/olas-core zod
```

## 30-second example

### Single-field validator

```ts
import { defineController } from '@kontsedal/olas-core'
import { zodValidator } from '@kontsedal/olas-zod'
import { z } from 'zod'

const signup = defineController((ctx) => ({
  email: ctx.field('', [zodValidator(z.string().email())]),
}))
```

### Whole form inferred from schema

```ts
import { formFromZod } from '@kontsedal/olas-zod'
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

const profileForm = defineController((ctx) => ({
  form: formFromZod(ctx, schema),
}))

// form.value.value: { name: string; age: number; address: { street, city }; tags: string[] }
```

`formFromZod` walks the schema:

- `z.object(...)` → `Form<...>` (recurses).
- `z.array(...)` → `FieldArray<...>` (recurses on element type).
- Anything else → `Field<...>` with `zodValidator(...)` attached.

Each leaf's initial value comes from the Zod schema's `.default(...)` if present, otherwise the empty value for the type (`''` for string, `0` for number, etc.). Override per-field with the `initials` option.

## API

```ts
function zodValidator<T>(schema: z.ZodType<T>): Validator<T>
function zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T>

function formFromZod<S extends z.ZodObject<z.ZodRawShape>>(
  ctx: Ctx,
  schema: S,
  options?: FormOptions<...>,
): Form<...>
```

`zodValidator` runs `schema.safeParse(value)` and reports the first `ZodIssue`'s `message`. `zodValidatorAsync` awaits `.safeParseAsync(...)` for schemas with async `.refine` / `.transform`.

Root-level `.refine(...)` rules on `z.object(...)` are **not** auto-promoted to a form-level validator today. Wire one manually with `ctx.form(fields, { validators: [zodValidator(schema)] })`, or assert on `form.isValid` for leaf-level rules. Tracked in [`../../BACKLOG.md`](../../BACKLOG.md).

## Limitation

Array-level `.min(N)` rules from the outer Zod schema are *not* promoted to a `FieldArray`-level validator today — leaf and nested-object rules walk correctly. Workaround: write a manual `FieldArrayValidator` for that case, or assert on `form.isValid` (driven by leaf rules). Tracked in [`../../BACKLOG.md`](../../BACKLOG.md).

## Further reading

- [`../../API.md`](../../API.md#olaszod) — full reference.
- [`../../.wiki/modules/zod.md`](../../.wiki/modules/zod.md)
- SPEC §8.7 (Zod integration), §20.7 (form types).
