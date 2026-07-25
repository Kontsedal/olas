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
 *
 * Zod has no native cancellation surface, so we race `safeParseAsync` against
 * the supplied `signal` and throw an `AbortError` if the signal fires. The
 * validator runner filters `AbortError` via `isAbortError`, so a superseded
 * pass never writes its result back.
 */
export function zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T> {
  return async (value, signal) => {
    if (signal?.aborted) throw makeAbortError()
    let onAbort: (() => void) | undefined
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(makeAbortError())
          signal.addEventListener('abort', onAbort)
        })
      : undefined
    // If `safeParseAsync` wins the race, `abortPromise` is left pending; a
    // later `abort()` would then reject it with nothing awaiting → an
    // unhandled rejection, and the listener would leak. Swallow the loser's
    // rejection, and ALWAYS remove the listener in `finally` (T6.5).
    abortPromise?.catch(() => {})
    try {
      const parsePromise = schema.safeParseAsync(value)
      const result = await (abortPromise
        ? Promise.race([parsePromise, abortPromise])
        : parsePromise)
      if (signal?.aborted) throw makeAbortError()
      if (result.success) return null
      return result.error.issues[0]?.message ?? 'Invalid'
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

function makeAbortError(): Error {
  // DOMException is the canonical AbortError but isn't available everywhere
  // (e.g. older Node ESM environments before 17). Fall back to a tagged Error.
  if (typeof DOMException === 'function') {
    return new DOMException('Aborted', 'AbortError')
  }
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Heuristic: does `s` look like a zod schema from a DIFFERENT copy of zod?
 * A schema from the copy WE import is `instanceof z.ZodType`; a foreign one
 * fails that but still carries a `def` (Zod 4) / `_def` (Zod 3) marker. All of
 * `formFromZod`'s introspection is `instanceof`-based, so a foreign schema
 * silently degrades to a flat field — hence the dev warning (T6.5).
 */
function isForeignZod(s: unknown): boolean {
  if (s === null || typeof s !== 'object') return false
  if (s instanceof z.ZodType) return false // our zod — fine
  const o = s as { def?: unknown; _def?: unknown }
  return o.def !== undefined || o._def !== undefined
}

function warnDuplicateZod(): void {
  // Not gated on NODE_ENV: this package has no build-time dev flag (`__DEV__`
  // is core-only), and the warning fires ONLY on a genuine misconfiguration (a
  // schema from a foreign zod copy) that's broken in every environment — so
  // there's no prod-noise concern.
  console.warn(
    '[olas-zod] a schema failed every zod `instanceof` check but looks like a zod schema ' +
      '(it has a `def`/`_def`). This almost always means TWO copies of `zod` are installed — ' +
      '`formFromZod` can only introspect schemas built with the SAME copy it imports, so a ' +
      'nested object/array here silently degrades to a flat field. Dedupe zod (e.g. `pnpm why zod`).',
  )
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
// Unwraps to a fixed point with identity-cycle detection so a pathological
// schema graph can never loop. `.optional().nullable().default(x).optional()`
// chains of any depth are handled.
function unwrap(schema: AnyZodType): AnyZodType {
  let s: AnyZodType = schema
  const seen = new Set<AnyZodType>()
  while (!seen.has(s)) {
    seen.add(s)
    if (s instanceof z.ZodDefault) {
      // ZodDefault stores the inner schema on `def.innerType` in Zod 4 (the
      // peer dep is `^4.0.0`). The public type is opaque, so read `def`
      // through a cast.
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
  // A `.transform(...)` / `.pipe(...)` is a `ZodPipe`. The form field holds the
  // INPUT the user edits (the transform runs on parse), so seed from the input
  // schema, not the piped output (T6.5). NOTE: `ZodToLeaf` still types the field
  // by `z.infer` (the output); the runtime initial is the input default.
  if (inner instanceof z.ZodPipe) {
    return defaultInitial((inner as unknown as { def: { in: AnyZodType } }).def.in)
  }
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
  // A Date field starts EMPTY — `null` was wrong (it flows a non-Date into a
  // `Date`-typed field). `undefined` + a required() validator is the clean
  // "user must pick a date" shape (T6.5).
  if (inner instanceof z.ZodDate) return undefined
  if (inner instanceof z.ZodBigInt) return 0n
  if (inner instanceof z.ZodLiteral) {
    const vals = (inner as unknown as { def: { values: readonly unknown[] } }).def?.values
    return vals?.[0]
  }
  if (inner instanceof z.ZodTuple) return []
  if (inner instanceof z.ZodRecord) return {}
  if (inner instanceof z.ZodMap) return new Map()
  if (inner instanceof z.ZodSet) return new Set()
  // For unknown/any/union/discriminated-union, undefined is the safest start.
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

  // Reached the leaf fallthrough: if `inner` still LOOKS like a zod schema but
  // isn't an instanceof ours, it's from a duplicate zod copy and a nested
  // object/array would have degraded to a flat field here — warn in dev (T6.5).
  if (isForeignZod(inner)) warnDuplicateZod()

  const ini = initial !== undefined ? initial : defaultInitial(schema)
  const validators: Array<Validator<unknown>> = [zodValidator(schema as z.ZodType<unknown>)]
  const extra = extras?.[path]
  if (extra !== undefined) validators.push(extra as Validator<unknown>)
  return ctx.field(ini, validators)
}
