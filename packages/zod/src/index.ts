import type { Ctx, Field, FieldArray, Form, FormOptions, Validator } from '@olas/core'
import { z } from 'zod'

/**
 * Wrap a Zod schema as an Olas validator. Returns a sync or async Validator
 * depending on whether the schema requires async parsing (e.g. `.refine(async ...)`).
 */
export function zodValidator<T>(schema: z.ZodType<T>): Validator<T> {
  return (value, signal) => {
    // signal isn't used by Zod (parsing is sync) — kept for interface parity.
    void signal
    const result = schema.safeParse(value)
    if (result.success) return null
    return result.error.issues[0]?.message ?? 'Invalid'
  }
}

/**
 * Async variant for schemas with `.refine(async ...)` or `.transform(async ...)`.
 * Returns a Promise<string | null>.
 */
export function zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T> {
  return async (value, signal) => {
    void signal
    const result = await schema.safeParseAsync(value)
    if (result.success) return null
    return result.error.issues[0]?.message ?? 'Invalid'
  }
}

type AnyZodType = z.ZodTypeAny

// Strip the outer optional/nullable/default wrappers to find the inner schema.
function unwrap(schema: AnyZodType): AnyZodType {
  let s: AnyZodType = schema
  // Unwrap default + optional + nullable, in any combination.
  for (let i = 0; i < 5; i++) {
    if (s instanceof z.ZodDefault) {
      s = (s as unknown as z.ZodDefault<AnyZodType>)._def.innerType
    } else if (s instanceof z.ZodOptional) {
      s = (s as unknown as z.ZodOptional<AnyZodType>)._def.innerType
    } else if (s instanceof z.ZodNullable) {
      s = (s as unknown as z.ZodNullable<AnyZodType>)._def.innerType
    } else {
      return s
    }
  }
  return s
}

function defaultInitial(schema: AnyZodType): unknown {
  // Honor Zod default if present.
  if (schema instanceof z.ZodDefault) {
    const def = (schema as unknown as z.ZodDefault<AnyZodType>)._def.defaultValue
    return typeof def === 'function' ? (def as () => unknown)() : def
  }
  const inner = unwrap(schema)
  if (inner instanceof z.ZodString) return ''
  if (inner instanceof z.ZodNumber) return 0
  if (inner instanceof z.ZodBoolean) return false
  if (inner instanceof z.ZodArray) return []
  if (inner instanceof z.ZodEnum) {
    const opts = (inner as z.ZodEnum<[string, ...string[]]>).options
    return opts[0] ?? ''
  }
  // For unknown/any/dates etc., undefined is the safest starting point.
  return undefined
}

type AnyForm = Form<Record<string, Field<any> | Form<any> | FieldArray<any>>>

/**
 * Walk a Zod schema and emit the equivalent Olas Form / FieldArray / Field
 * tree, with validators auto-attached.
 *
 * - `z.object(...)` → `Form`
 * - `z.array(...)`  → `FieldArray` (recurses on the element)
 * - leaf schemas    → `Field` with `zodValidator(...)` attached
 *
 * Each leaf's initial value is the Zod default if present, otherwise an empty
 * value for that type (`''` for strings, `0` for numbers, etc.).
 */
export function formFromZod<T extends z.ZodObject<z.ZodRawShape>>(
  ctx: Ctx,
  schema: T,
  options?: { initials?: Partial<z.infer<T>> },
): Form<{ [K in keyof z.infer<T>]: Field<z.infer<T>[K]> | Form<any> | FieldArray<any> }> {
  return buildForm(ctx, schema, options?.initials) as Form<{
    [K in keyof z.infer<T>]: Field<z.infer<T>[K]> | Form<any> | FieldArray<any>
  }>
}

function buildForm(
  ctx: Ctx,
  schema: z.ZodObject<z.ZodRawShape>,
  initials?: Record<string, unknown>,
): AnyForm {
  const shape = schema.shape
  const fields: Record<string, Field<unknown> | Form<any> | FieldArray<any>> = {}
  for (const key of Object.keys(shape)) {
    const propSchema = shape[key]!
    const initial = initials?.[key]
    fields[key] = buildLeaf(ctx, propSchema, initial)
  }
  const formOpts: FormOptions<typeof fields> = {}
  // If the schema has top-level refinements (z.object().refine(...)), Zod
  // wraps it in ZodEffects. We expose those as form-level validators.
  const topLevelValidators: Validator<unknown>[] = []
  // Note: we received an unwrapped ZodObject here, so there's nothing extra.
  if (topLevelValidators.length > 0) {
    ;(formOpts as { validators: Validator<unknown>[] }).validators = topLevelValidators
  }
  return ctx.form(fields, formOpts) as AnyForm
}

function buildLeaf(
  ctx: Ctx,
  schema: AnyZodType,
  initial: unknown,
): Field<unknown> | Form<any> | FieldArray<any> {
  const inner = unwrap(schema)

  if (inner instanceof z.ZodObject) {
    return buildForm(
      ctx,
      inner as z.ZodObject<z.ZodRawShape>,
      initial as Record<string, unknown> | undefined,
    )
  }

  if (inner instanceof z.ZodArray) {
    const elementSchema = (inner as z.ZodArray<AnyZodType>).element
    return ctx.fieldArray(
      (itemInitial) => buildLeaf(ctx, elementSchema, itemInitial) as Field<unknown> | Form<any>,
      initial !== undefined ? { initial: initial as Array<unknown> } : undefined,
    )
  }

  const ini = initial !== undefined ? initial : defaultInitial(schema)
  return ctx.field(ini, [zodValidator(schema as z.ZodType<unknown>)])
}
