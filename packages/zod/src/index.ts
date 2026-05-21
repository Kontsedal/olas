import {
  type Ctx,
  type Field,
  type FieldArray,
  type Form,
  type StandardSchemaV1,
  validator as standardValidator,
  type Validator,
} from '@kontsedal/olas-core'
import { z } from 'zod'

/**
 * Wrap a Zod schema as an Olas validator. Zod 4 implements Standard Schema
 * v1, so this is now a thin alias over the cross-library `validator(...)`
 * from `@kontsedal/olas-core`. Kept under its existing name for back-compat
 * and for code that intentionally signals "this is a Zod schema."
 */
export function zodValidator<T>(schema: z.ZodType<T>): Validator<T> {
  return standardValidator(schema as unknown as StandardSchemaV1<T, T>)
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

/**
 * Run the schema and report only **root-level** issues (those with empty
 * `path`). Leaf issues are already covered by `zodValidator(propSchema)` on
 * each leaf field — surfacing them here would double-count.
 *
 * Used by `formFromZod` to lift root-level `.refine(...)` rules into a
 * form-level validator. Returns `null` when every issue belongs to a leaf
 * (or there are no issues at all).
 */
export function rootOnlyZodValidator<T>(schema: z.ZodType<T>): Validator<T> {
  return (value, signal) => {
    void signal
    const result = schema.safeParse(value)
    if (result.success) return null
    for (const issue of result.error.issues) {
      if (issue.path.length === 0) return issue.message
    }
    return null
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
/**
 * Per-leaf extra validators keyed by dotted path. Match the leaf field's
 * position inside the schema:
 *
 * - top-level: `'title'`
 * - nested form: `'address.street'`
 *
 * `FieldArray` items aren't separately addressable — the schema walker
 * generates one factory per array, so a path of `'tags'` matches the
 * `FieldArray` (validators attached there apply to the array as a whole;
 * use Olas's `FieldArrayOptions.validators` shape). Per-element rules
 * already live on the Zod element schema and are attached automatically.
 *
 * Validators run alongside `zodValidator(schema)` — both must pass.
 */
export type ExtraValidators = Record<string, Validator<any>>

export type FormFromZodOptions<T extends z.ZodObject<z.ZodRawShape>> = {
  initials?: Partial<z.infer<T>>
  extraValidators?: ExtraValidators
}

export function formFromZod<T extends z.ZodObject<z.ZodRawShape>>(
  ctx: Ctx,
  schema: T,
  options?: FormFromZodOptions<T>,
): Form<{ [K in keyof T['shape']]: ZodToLeaf<T['shape'][K]> }> {
  return buildForm(ctx, schema, options?.initials, '', options?.extraValidators, schema) as never
}

function buildForm(
  ctx: Ctx,
  schema: z.ZodObject<z.ZodRawShape>,
  initials: Record<string, unknown> | undefined,
  path: string,
  extras: ExtraValidators | undefined,
  /**
   * The original top-level schema. Passed only when constructing the ROOT
   * form — nested `buildForm` calls (from object-typed leaves) pass
   * `undefined`. Used to attach a root-only Zod validator so
   * `z.object({...}).refine(fn)` rules surface as form-level errors
   * without double-reporting leaf issues. See `rootOnlyZodValidator`.
   */
  rootSchema?: z.ZodObject<z.ZodRawShape>,
): AnyForm {
  const shape = schema.shape
  const fields: Record<string, Field<unknown> | Form<any> | FieldArray<any>> = {}
  for (const key of Object.keys(shape)) {
    const propSchema = shape[key] as AnyZodType
    const initial = initials?.[key]
    const leafPath = path === '' ? key : `${path}.${key}`
    fields[key] = buildLeaf(ctx, propSchema, initial, leafPath, extras)
  }
  // Lift root-level `.refine(...)` checks on the top-level object into a
  // form-level validator. Leaf checks remain owned by leaf-level
  // `zodValidator(propSchema)`; `rootOnlyZodValidator` filters to issues
  // whose `path` is empty so leaf issues are not double-reported.
  if (rootSchema !== undefined) {
    return ctx.form(fields, {
      validators: [rootOnlyZodValidator(rootSchema as z.ZodType<unknown>) as never],
    }) as AnyForm
  }
  return ctx.form(fields) as AnyForm
}

function buildLeaf(
  ctx: Ctx,
  schema: AnyZodType,
  initial: unknown,
  path: string,
  extras: ExtraValidators | undefined,
): Field<unknown> | Form<any> | FieldArray<any> {
  const inner = unwrap(schema)

  if (inner instanceof z.ZodObject) {
    return buildForm(
      ctx,
      inner as z.ZodObject<z.ZodRawShape>,
      initial as Record<string, unknown> | undefined,
      path,
      extras,
    )
  }

  if (inner instanceof z.ZodArray) {
    const elementSchema = (inner as z.ZodArray<AnyZodType>).element as AnyZodType
    return ctx.fieldArray(
      // Array items aren't enumerable at schema-build time; we don't extend
      // the dotted path with an index here. Per-item validators belong on
      // the Zod element schema (which `buildLeaf` already wraps via
      // `zodValidator`).
      (itemInitial) =>
        buildLeaf(ctx, elementSchema, itemInitial, path, extras) as Field<unknown> | Form<any>,
      initial !== undefined ? { initial: initial as Array<unknown> } : undefined,
    )
  }

  const ini = initial !== undefined ? initial : defaultInitial(schema)
  const validators: Array<Validator<unknown>> = [zodValidator(schema as z.ZodType<unknown>)]
  const extra = extras?.[path]
  if (extra !== undefined) validators.push(extra as Validator<unknown>)
  return ctx.field(ini, validators)
}
