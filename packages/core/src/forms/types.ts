/**
 * A single validation issue, optionally targeting a descendant of a form tree.
 *
 * - An **empty** `path` means the node the validator is attached to itself —
 *   for a leaf `Field` that's the field; for a `Form` / `FieldArray` it's the
 *   node's `topLevelErrors`.
 * - A **non-empty** `path` routes the `message` to the matching descendant
 *   (`Form` walks keys, `FieldArray` walks numeric indices). Unresolvable
 *   paths fall back to the owning node's `topLevelErrors` rather than vanishing.
 *
 * Segments are object keys (`string`) or array indices (`number`). Returned by
 * form-level validators (cross-field rules) and by the Standard-Schema
 * `validator(...)` adapter, which maps each `issue.path` here. See SPEC §8.3.
 */
export type FormIssue = { path: (string | number)[]; message: string }

/**
 * What a {@link Validator} may return synchronously. A plain `string` is a
 * message on the node itself (equivalent to a `FormIssue` with an empty path);
 * `null` means "no error"; a `FormIssue[]` targets specific descendants.
 */
export type ValidatorResult = string | null | FormIssue[]

/**
 * Checks one value: `null` when it passes, a message or `FormIssue[]` when it
 * fails, returned at once or as a promise. `signal` aborts when a newer run
 * supersedes this one and on dispose, so an async validator can cancel its
 * request.
 */
export type Validator<T> = (
  value: T,
  signal: AbortSignal,
) => ValidatorResult | Promise<ValidatorResult>
