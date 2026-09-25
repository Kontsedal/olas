/**
 * One failure a Standard Schema reports: its message, and the path to the
 * value that failed. `validator(schema)` turns each into a `FormIssue`.
 */
export type StandardSchemaV1Issue = {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
}

/** What a Standard Schema's `validate` returns: the parsed `value`, or the `issues`. */
export type StandardSchemaV1Result<O> =
  | { readonly value: O; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaV1Issue> }

/**
 * Standard Schema v1 — the cross-library validation contract adopted by
 * Zod 4, Valibot 1, ArkType 2, and others. See https://standardschema.dev.
 * `I` is the schema's input type and `O` its output type.
 *
 * We type-only-import the shape so consumers don't take a new runtime dep:
 * any object with a `~standard.validate(value)` method conforming to this
 * structure works. `validator(schema)` wraps one as a `Validator`.
 */
export type StandardSchemaV1<I = unknown, O = I> = {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): StandardSchemaV1Result<O> | Promise<StandardSchemaV1Result<O>>
    readonly types?: { readonly input: I; readonly output: O } | undefined
  }
}

/**
 * Heuristic: does `x` look like a Standard Schema?
 */
export function isStandardSchema(x: unknown): x is StandardSchemaV1<unknown, unknown> {
  return (
    x !== null &&
    typeof x === 'object' &&
    '~standard' in x &&
    typeof (x as { '~standard': { validate?: unknown } })['~standard']?.validate === 'function'
  )
}
