# @olas/zod

Zod ↔ Olas forms adapter. Two helpers — `zodValidator` (single field) and `formFromZod` (whole form, inferred from schema).

Olas core stays Zod-free. This package has a peer dep on `zod ^3`.

## Install

```bash
pnpm add @olas/zod @olas/core zod
```

## 30-second example

### Single-field validator

```ts
import { defineController } from '@olas/core'
import { zodValidator } from '@olas/zod'
import { z } from 'zod'

const signup = defineController((ctx) => ({
  email: ctx.field('', [zodValidator(z.string().email())]),
}))
```

### Whole form inferred from schema

```ts
import { formFromZod } from '@olas/zod'
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

Form-level `.refine(...)` on the root `z.object(...)` is attached as a top-level form validator (surfaces via `form.topLevelErrors`).

## Further reading

- [`.wiki/modules/zod.md`](../../.wiki/modules/zod.md)
- Spec §8.7 (Zod integration), §20.7 (form types).
