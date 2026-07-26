# @kontsedal/olas-zod

Zod ↔ Olas forms adapter. Point a single `Field` at a schema with `zodValidator` (or `zodValidatorAsync` for async refinements), or infer a whole `Form` from a `z.object(...)` with `formFromZod` — either way the schema is the one source of truth for both *shape* and *validation*.

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

| Export | What |
|---|---|
| `zodValidator(schema)` | A `Validator<T>` for a single `Field`. Reports the first issue's message. |
| `zodValidatorAsync(schema)` | Async variant — awaits `safeParseAsync`, for schemas with async `.refine` / `.transform`. |
| `formFromZod(ctx, schema, options?)` | Walks a `z.object(...)` into a matching `Form` / `Field` / `FieldArray` tree with validators auto-attached. |

## Limitations

Leaf and nested-object rules walk correctly in every case. Two outer-schema rules aren't auto-promoted yet (both tracked in [`../../BACKLOG.md`](../../BACKLOG.md)):

- **Root-level `.refine(...)` on `z.object(...)`** → no form-level validator. Wire one manually with `ctx.form(fields, { validators: [zodValidator(schema)] })`, or assert on `form.isValid`.
- **Array-level `.min(N)`** → no `FieldArray`-level validator. Write a manual `FieldArrayValidator`, or assert on `form.isValid`.

## Further reading

- [`../../API.md`](../../API.md#olaszod) — full reference.
- [`../../.wiki/modules/zod.md`](../../.wiki/modules/zod.md)
- [SPEC §8.7](../../SPEC.md#87-zod-integration-kontsedalolas-zod) (Zod integration), [§20.7](../../SPEC.md#207-fields-forms--validators) (form types).
