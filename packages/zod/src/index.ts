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

// Zod 4 typed every wrapper as `z.ZodType`-compatible; the public unwrap path
// is `.unwrap()` for optional/nullable and `.def.innerType` for default.
type AnyZodType = z.ZodType

// Strip the outer optional/nullable/default wrappers to find the inner schema.
function unwrap(schema: AnyZodType): AnyZodType {
  let s: AnyZodType = schema
  // Unwrap default + optional + nullable, in any combination.
  for (let i = 0; i < 5; i++) {
    if (s instanceof z.ZodDefault) {
      // ZodDefault stores the inner schema on `def.innerType`. The runtime
      // shape is stable across 3.x and 4.x; the public type just shifts.
      s = (s as unknown as { def: { innerType: AnyZodType } }).def.innerType
    } else if (s instanceof z.ZodOptional) {
      s = (s as z.ZodOptional<AnyZodType>).unwrap() as AnyZodType
    } else if (s instanceof z.ZodNullable) {
      s = (s as z.ZodNullable<AnyZodType>).unwrap() as AnyZodType
    } else {
      return s
    }
  }
  return s
}

function defaultInitial(schema: AnyZodType): unknown {
  // Honor Zod default if present.
  if (schema instanceof z.ZodDefault) {
    const raw = (schema as unknown as { def: { defaultValue: unknown } }).def.defaultValue
    return typeof raw === 'function' ? (raw as () => unknown)() : raw
  }
  const inner = unwrap(schema)
  if (inner instanceof z.ZodString) return ''
  if (inner instanceof z.ZodNumber) return 0
  if (inner instanceof z.ZodBoolean) return false
  if (inner instanceof z.ZodArray) return []
  if (inner instanceof z.ZodEnum) {
    // Zod 4 widened ZodEnum's options to support record-style enums. The
    // runtime values are still iterable; pick the first.
    const opts = (inner as unknown as { options: readonly unknown[] }).options
    const first = opts[0]
    return typeof first === 'string' ? first : ''
  }
  // For unknown/any/dates etc., undefined is the safest starting point.
  return undefined
}

type AnyForm = Form<Record<string, Field<any> | Form<any> | FieldArray<any>>>

// Strip the same wrappers as the runtime `unwrap` helper, at the type level.
type UnwrapZod<S> =
  S extends z.ZodDefault<infer Inner>
    ? UnwrapZod<Inner>
    : S extends z.ZodOptional<infer Inner>
      ? UnwrapZod<Inner>
      : S extends z.ZodNullable<infer Inner>
        ? UnwrapZod<Inner>
        : S

/**
 * Recursively map a Zod schema to its Olas form leaf:
 *  - `ZodObject<S>` → `Form<{ [K]: ZodToLeaf<S[K]> }>`
 *  - `ZodArray<E>`  → `FieldArray<ZodToLeaf<E>>` (when E is object/array)
 *                     or `FieldArray<Field<infer<E>>>` for primitive elements.
 *  - everything else → `Field<infer<S>>`.
 *
 * `ZodToLeaf<S>` matches what `buildLeaf(ctx, s, ...)` returns at runtime,
 * so the public `formFromZod<T>` can publish a precise structural type
 * without the consumer needing a hand-written `CardForm = Form<{...}>` cast.
 */
export type ZodToLeaf<S> =
  UnwrapZod<S> extends z.ZodObject<infer RawShape>
    ? Form<{ [K in keyof RawShape]: ZodToLeaf<RawShape[K]> }>
    : UnwrapZod<S> extends z.ZodArray<infer Element>
      ? FieldArray<ZodToLeaf<Element> extends Form<any> | Field<any> ? ZodToLeaf<Element> : never>
      : Field<z.infer<UnwrapZod<S> & z.ZodType>>

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
 *
 * The return type is structurally precise — `form.fields.title.value` is
 * `string` (not `string | boolean | …`), `form.fields.subtasks.add(...)`
 * accepts the exact item shape, etc. Consumers do not need to hand-write
 * a `CardForm = Form<{...}>` matching the schema.
 */
export function formFromZod<T extends z.ZodObject<z.ZodRawShape>>(
  ctx: Ctx,
  schema: T,
  options?: { initials?: Partial<z.infer<T>> },
): Form<{ [K in keyof T['shape']]: ZodToLeaf<T['shape'][K]> }> {
  return buildForm(ctx, schema, options?.initials) as never
}

function buildForm(
  ctx: Ctx,
  schema: z.ZodObject<z.ZodRawShape>,
  initials?: Record<string, unknown>,
): AnyForm {
  const shape = schema.shape
  const fields: Record<string, Field<unknown> | Form<any> | FieldArray<any>> = {}
  for (const key of Object.keys(shape)) {
    const propSchema = shape[key] as AnyZodType
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
    const elementSchema = (inner as z.ZodArray<AnyZodType>).element as AnyZodType
    return ctx.fieldArray(
      (itemInitial) => buildLeaf(ctx, elementSchema, itemInitial) as Field<unknown> | Form<any>,
      initial !== undefined ? { initial: initial as Array<unknown> } : undefined,
    )
  }

  const ini = initial !== undefined ? initial : defaultInitial(schema)
  return ctx.field(ini, [zodValidator(schema as z.ZodType<unknown>)])
}
