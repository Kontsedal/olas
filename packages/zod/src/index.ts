import {
  type Ctx,
  createField,
  createFieldArray,
  createForm,
  type DeepPartial,
  type Field,
  type FieldArray,
  type Form,
  type FormIssue,
  type StandardSchemaV1,
  validator as standardValidator,
  type Validator,
  type ValidatorResult,
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
 * `createZodForm`'s introspection is `instanceof`-based, so a foreign schema
 * silently degrades to a flat field — hence the dev warning (T6.5).
 */
function isForeignZod(s: unknown): boolean {
  if (s === null || typeof s !== 'object') return false
  if (s instanceof z.ZodType) return false // our zod — fine
  const o = s as { def?: unknown; _def?: unknown }
  return o.def !== undefined || o._def !== undefined
}

/**
 * Once per process. A duplicate zod copy shows up on every leaf the walker
 * visits, in every form, and one warning names the fix for all of them.
 */
let warnedDuplicateZod = false

function warnDuplicateZod(): void {
  // Not gated on `__DEV__`, on purpose: the warning fires ONLY on a genuine
  // misconfiguration (a schema from a foreign zod copy) that's broken in every
  // environment, so the production build keeps it too. It costs nothing when
  // there is no foreign copy.
  if (warnedDuplicateZod) return
  warnedDuplicateZod = true
  console.warn(
    '[olas-zod] a schema failed every zod `instanceof` check but looks like a zod schema ' +
      '(it has a `def`/`_def`). This almost always means TWO copies of `zod` are installed — ' +
      '`createZodForm` can only introspect schemas built with the SAME copy it imports, so a ' +
      'nested object/array here silently degrades to a flat field. Dedupe zod (e.g. `pnpm why zod`).',
  )
}

/**
 * Run the schema and report only its first **root-level** issue, one with an
 * empty `path`. Every issue with a path is dropped, on the assumption that
 * each leaf field carries its own validator and reports it there.
 *
 * For a hand-built `createForm` whose leaves validate themselves.
 * `createZodForm` does not use it: it installs a validator that also routes
 * a path-carrying rule, such as `.refine(fn, { path: ['confirm'] })` or an
 * array's `.min(3)`, onto the node the path names. Returns `null` when the
 * schema has no root-level issue.
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

// Strip one optional/nullable/default wrapper, or return `undefined` when
// `schema` is not one of them.
function unwrapOnce(schema: AnyZodType): AnyZodType | undefined {
  if (schema instanceof z.ZodDefault) {
    // ZodDefault stores the inner schema on `def.innerType` in Zod 4 (the
    // peer dep is `^4.0.0`). The public type is opaque, so read `def`
    // through a cast.
    return (schema as unknown as { def: { innerType: AnyZodType } }).def.innerType
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return (schema as z.ZodOptional<AnyZodType>).unwrap() as AnyZodType
  }
  return undefined
}

// Strip the outer optional/nullable/default wrappers to find the inner schema.
// Unwraps to a fixed point with identity-cycle detection so a pathological
// schema graph can never loop. `.optional().nullable().default(x).optional()`
// chains of any depth are handled.
function unwrap(schema: AnyZodType): AnyZodType {
  let s: AnyZodType = schema
  const seen = new Set<AnyZodType>()
  while (!seen.has(s)) {
    seen.add(s)
    const next = unwrapOnce(s)
    if (next === undefined) return s
    s = next
  }
  return s
}

/** Does `createZodForm` build this schema into a `Form` or a `FieldArray`, not a `Field`? */
function isStructural(schema: AnyZodType): boolean {
  const inner = unwrap(schema)
  return inner instanceof z.ZodObject || inner instanceof z.ZodArray
}

// Zod 4 keeps a schema's own rules on `def.checks`: `.refine`, `.superRefine`
// and `.check` on any schema, and `.min`, `.max`, `.length` and `.nonempty`
// on an array. The list is absent when there are none.
const hasOwnChecks = (schema: AnyZodType): boolean =>
  ((schema as unknown as { def: { checks?: readonly unknown[] } }).def.checks?.length ?? 0) > 0

/**
 * Does an object or an array in the form's structure carry a rule of its
 * own? Only a parse of the whole schema reports such a rule, because no leaf
 * validator sees the object or the array it is on. A leaf's rules are not
 * counted: its own `zodValidator` reports them.
 *
 * `seen` stops a recursive schema. A getter-built `z.object` can reach itself
 * through an array, and a schema already walked had no rule, or the walk
 * would have returned.
 */
function hasStructuralRules(schema: AnyZodType, seen: Set<AnyZodType> = new Set()): boolean {
  let s: AnyZodType | undefined = schema
  let inner: AnyZodType = schema
  // A wrapper can carry the rule too: `z.object({...}).optional().refine(fn)`
  // puts it on the `ZodOptional`.
  while (s !== undefined) {
    if (seen.has(s)) return false
    seen.add(s)
    if (hasOwnChecks(s)) return true
    inner = s
    s = unwrapOnce(s)
  }
  const children =
    inner instanceof z.ZodObject
      ? (Object.values((inner as z.ZodObject<z.ZodRawShape>).shape) as AnyZodType[])
      : [(inner as z.ZodArray<AnyZodType>).element as AnyZodType]
  return children.some((child) => isStructural(child) && hasStructuralRules(child, seen))
}

/**
 * Find the leaf field an issue path reaches in the tree `createZodForm`
 * builds from `root`. Returns the leaf's schema, which is the one its own
 * `zodValidator` runs, the path to the leaf, and the leaf's value. Returns
 * `undefined` when no leaf owns the path: it ends at a `Form` or a
 * `FieldArray`, or it names a key the schema does not have.
 */
function leafAlong(
  root: AnyZodType,
  path: ReadonlyArray<string | number>,
  value: unknown,
): { schema: AnyZodType; path: (string | number)[]; value: unknown } | undefined {
  let node = root
  let cursor = value
  for (let depth = 0; ; depth++) {
    const inner = unwrap(node)
    if (!(inner instanceof z.ZodObject) && !(inner instanceof z.ZodArray)) {
      return { schema: node, path: path.slice(0, depth), value: cursor }
    }
    if (depth === path.length) return undefined
    const seg = path[depth] as string | number
    // An array descends whatever the segment is, as core's router does: it
    // reads a numeric string as an index, and anything else runs off the tree.
    const shape = (inner as z.ZodObject<z.ZodRawShape>).shape as Record<string, AnyZodType>
    const next =
      inner instanceof z.ZodArray
        ? ((inner as z.ZodArray<AnyZodType>).element as AnyZodType)
        : Object.hasOwn(shape, seg)
          ? shape[seg]
          : undefined
    if (next === undefined) return undefined
    node = next
    // A refine's `path` can name an array index the value does not have.
    cursor = (cursor as Record<PropertyKey, unknown> | undefined)?.[seg]
  }
}

/**
 * Keep the whole-schema issues that no leaf validator reports, with paths
 * the form can route. An issue with no owning leaf keeps its path. An issue
 * at or under a leaf is cut to the leaf's path, and is dropped when the
 * leaf's own schema reports the same message for the same value: the leaf's
 * field already shows it.
 *
 * `zodValidator` is core's Standard Schema `validator`, which resolves each
 * run to a `FormIssue[]`, empty when the value is valid. It never returns
 * the `string` or `null` a `Validator` may, hence the casts.
 */
function unownedIssues(
  root: AnyZodType,
  value: unknown,
  result: ValidatorResult,
  signal: AbortSignal,
): FormIssue[] | Promise<FormIssue[]> {
  const kept = (result as FormIssue[]).map((issue) => {
    const leaf = leafAlong(root, issue.path, value)
    if (leaf === undefined) return issue
    const keep = (own: ValidatorResult) =>
      (own as FormIssue[]).some((o) => o.message === issue.message)
        ? undefined
        : { path: leaf.path, message: issue.message }
    const own = zodValidator(leaf.schema as z.ZodType<unknown>)(leaf.value, signal)
    return own instanceof Promise ? own.then(keep) : keep(own)
  })
  const defined = (list: Array<FormIssue | undefined>) =>
    list.filter((issue): issue is FormIssue => issue !== undefined)
  return kept.some((issue) => issue instanceof Promise)
    ? Promise.all(kept).then(defined)
    : defined(kept as Array<FormIssue | undefined>)
}

/**
 * The form-level validator `createZodForm` installs when the schema has a
 * rule on an object or an array. It parses the whole schema, and each issue
 * that no leaf validator reports lands on the node its path names:
 *
 * - a root `.refine(fn)` with no `path` → `form.topLevelErrors`;
 * - a `.refine(fn, { path: ['confirm'] })` → the `confirm` field's errors;
 * - an array's `.min(3)` → that `FieldArray`'s `topLevelErrors`;
 * - a nested object's `.refine(fn)` → that nested form's `topLevelErrors`.
 *
 * A message a leaf's own schema reports is dropped here, because the leaf's
 * field already shows it. An async rule is awaited, as core's `validator`
 * awaits one.
 */
function schemaRulesValidator(root: z.ZodObject<z.ZodRawShape>): Validator<unknown> {
  const whole = zodValidator(root as z.ZodType<unknown>)
  return (value, signal) => {
    const result = whole(value, signal)
    return result instanceof Promise
      ? result.then((settled) => unownedIssues(root, value, settled, signal))
      : unownedIssues(root, value, result, signal)
  }
}

/**
 * The schema's Zod default, boxed so a default of `undefined` still counts,
 * or `undefined` when it has none. A default under `.optional()` /
 * `.nullable()` counts too: a missing key reaches the inner default, as
 * `schema.parse({})` shows. Leaves, objects and arrays all read it here.
 */
function zodDefault(schema: AnyZodType): { value: unknown } | undefined {
  let s: AnyZodType = schema
  const seen = new Set<AnyZodType>()
  while (!seen.has(s)) {
    seen.add(s)
    if (s instanceof z.ZodDefault) {
      // Zod 4's `def.defaultValue` is a getter that already runs a function
      // default, so this is the default itself — even when it is a function.
      return { value: (s as unknown as { def: { defaultValue: unknown } }).def.defaultValue }
    }
    if (s instanceof z.ZodOptional) s = (s as z.ZodOptional<AnyZodType>).unwrap() as AnyZodType
    else if (s instanceof z.ZodNullable) s = (s as z.ZodNullable<AnyZodType>).unwrap() as AnyZodType
    else break
  }
  return undefined
}

function defaultInitial(schema: AnyZodType): unknown {
  const zodDefaulted = zodDefault(schema)
  if (zodDefaulted !== undefined) return zodDefaulted.value
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
    // A record-style enum can have numeric values: seed the first either way.
    return typeof first === 'string' || typeof first === 'number' ? first : ''
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

/**
 * A Zod schema with its `.default()`, `.optional()` and `.nullable()` wrappers
 * stripped — the type-level twin of the runtime unwrap `createZodForm` does
 * before choosing a leaf.
 */
export type UnwrapZod<S> =
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
 * so the public `createZodForm<T>` can publish a precise structural type
 * without the consumer needing a hand-written `CardForm = Form<{...}>` cast.
 */
export type ZodToLeaf<S> =
  UnwrapZod<S> extends z.ZodObject<infer RawShape>
    ? Form<{ [K in keyof RawShape]: ZodToLeaf<RawShape[K]> }>
    : UnwrapZod<S> extends z.ZodArray<infer Element>
      ? FieldArray<ZodToLeaf<Element> extends Form<any> | Field<any> ? ZodToLeaf<Element> : never>
      : Field<z.infer<UnwrapZod<S> & z.ZodType>>

/**
 * Per-leaf extra validators keyed by dotted path. Match the leaf field's
 * position inside the schema:
 *
 * - top-level: `'title'`
 * - nested form: `'address.street'`
 *
 * A path names a position in the SCHEMA, not in the value, and an array
 * contributes no segment to it. So a path at or under an array applies to
 * every element:
 *
 * - `z.array(z.string())` under `tags` → `'tags'` validates each tag
 * - `z.array(z.object({ name }))` under `tags` → `'tags.name'` validates
 *   each item's `name` field
 *
 * There is no path that addresses the `FieldArray` itself. Put an
 * array-level rule, such as "at least three tags" or "no duplicates", in the
 * Zod schema instead: `z.array(...).min(3)` or `z.array(...).refine(fn)`.
 * `createZodForm` enforces it, and its message lands in the array's
 * `topLevelErrors`.
 *
 * Validators run alongside `zodValidator(schema)` — both must pass.
 */
export type ExtraValidators = Record<string, Validator<any>>

/** Options for `createZodForm(ctx, schema, options?)`. */
export type ZodFormOptions<T extends z.ZodObject<z.ZodRawShape>> = {
  /**
   * Initial values, as for `createForm`: a partial value, or a tracked
   * function. A function re-seats the form when the signals it reads change,
   * while the form is not dirty — the form-from-server pattern (spec §8.4).
   * Fields the initial leaves out start at their Zod default, else an empty
   * value for their type.
   */
  initial?: DeepPartial<z.infer<T>> | (() => DeepPartial<z.infer<T>> | undefined)
  /**
   * When a function `initial` changes: see `FormOptions.resetOnInitialChange`.
   */
  resetOnInitialChange?: 'when-clean' | 'never' | 'always'
  extraValidators?: ExtraValidators
}

/**
 * Walk a Zod schema and emit the equivalent Olas Form / FieldArray / Field
 * tree, with validators auto-attached.
 *
 * - `z.object(...)` → `Form`
 * - `z.array(...)`  → `FieldArray` (recurses on the element)
 * - leaf schemas    → `Field` with `zodValidator(...)` attached
 *
 * Each leaf's initial value is the Zod default if present, otherwise an empty
 * value for that type (`''` for strings, `0` for numbers, etc.). A
 * `.default(...)` on an object or an array seeds that nested form or field
 * array as a whole, as `schema.parse({})` fills the key.
 *
 * A rule on an object or an array is enforced too. A root `.refine(fn)`
 * lands in `form.topLevelErrors`, a `.refine(fn, { path: ['confirm'] })`
 * lands on `confirm`, and `z.array(...).min(3)` lands in that array's
 * `topLevelErrors`. The form parses the whole schema for these on every
 * change, so a schema with no such rule does not get that validator.
 *
 * The return type is structurally precise — `form.fields.title.value` is
 * `string` (not `string | boolean | …`), `form.fields.subtasks.add(...)`
 * accepts the exact item shape, etc. Consumers do not need to hand-write
 * a `CardForm = Form<{...}>` matching the schema.
 */
export function createZodForm<T extends z.ZodObject<z.ZodRawShape>>(
  ctx: Ctx,
  schema: T,
  options?: ZodFormOptions<T>,
): Form<{ [K in keyof T['shape']]: ZodToLeaf<T['shape'][K]> }> {
  const initial = options?.initial
  // A value seeds the leaves as they are built. A function is the root
  // form's tracked initial, so it re-seats exactly as `createForm` does.
  const tracked =
    typeof initial === 'function'
      ? {
          initial: initial as () => Record<string, unknown> | undefined,
          resetOnInitialChange: options?.resetOnInitialChange,
        }
      : undefined
  return buildForm(
    ctx,
    schema,
    typeof initial === 'function' ? undefined : (initial as Record<string, unknown> | undefined),
    '',
    options?.extraValidators,
    schema,
    tracked,
  ) as never
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
   * `undefined`. When an object or an array in it carries a rule, the root
   * form gets `schemaRulesValidator(rootSchema)`, which enforces every such
   * rule anywhere in the tree without repeating a leaf's own message.
   */
  rootSchema?: z.ZodObject<z.ZodRawShape>,
  tracked?: {
    initial: () => Record<string, unknown> | undefined
    resetOnInitialChange: 'when-clean' | 'never' | 'always' | undefined
  },
): AnyForm {
  const shape = schema.shape
  const fields: Record<string, Field<unknown> | Form<any> | FieldArray<any>> = {}
  for (const key of Object.keys(shape)) {
    const propSchema = shape[key] as AnyZodType
    const initial = initials?.[key]
    const leafPath = path === '' ? key : `${path}.${key}`
    fields[key] = buildLeaf(ctx, propSchema, initial, leafPath, extras)
  }
  // A leaf's rules stay with the leaf's own `zodValidator`. A rule on an
  // object or an array needs a parse of the whole schema, and that parse
  // runs on every change to the form, so it is installed only when the
  // schema has such a rule. A plain schema pays for its leaves alone.
  if (rootSchema !== undefined) {
    return createForm(ctx, fields, {
      ...(hasStructuralRules(rootSchema)
        ? { validators: [schemaRulesValidator(rootSchema) as never] }
        : {}),
      ...(tracked !== undefined
        ? {
            initial: tracked.initial as never,
            ...(tracked.resetOnInitialChange !== undefined
              ? { resetOnInitialChange: tracked.resetOnInitialChange }
              : {}),
          }
        : {}),
    }) as AnyForm
  }
  return createForm(ctx, fields) as AnyForm
}

function buildLeaf(
  ctx: Ctx,
  schema: AnyZodType,
  initial: unknown,
  path: string,
  extras: ExtraValidators | undefined,
): Field<unknown> | Form<any> | FieldArray<any> {
  const inner = unwrap(schema)
  // A `.default(...)` on an object or an array seeds it as a whole, the way
  // `schema.parse({})` fills the key. An initial value the caller passed wins.
  const seed =
    initial === undefined && (inner instanceof z.ZodObject || inner instanceof z.ZodArray)
      ? zodDefault(schema)?.value
      : initial

  if (inner instanceof z.ZodObject) {
    return buildForm(
      ctx,
      inner as z.ZodObject<z.ZodRawShape>,
      seed as Record<string, unknown> | undefined,
      path,
      extras,
    )
  }

  if (inner instanceof z.ZodArray) {
    const elementSchema = (inner as z.ZodArray<AnyZodType>).element as AnyZodType
    return createFieldArray(
      ctx,
      // Array items aren't enumerable at schema-build time; we don't extend
      // the dotted path with an index here. Per-item validators belong on
      // the Zod element schema (which `buildLeaf` already wraps via
      // `zodValidator`).
      (itemInitial) =>
        buildLeaf(ctx, elementSchema, itemInitial, path, extras) as Field<unknown> | Form<any>,
      seed !== undefined ? { initial: seed as Array<unknown> } : undefined,
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
  return createField(ctx, ini, { validators: validators })
}
