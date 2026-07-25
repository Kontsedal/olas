import type { StandardSchemaV1, StandardSchemaV1Issue } from './standard-schema'
import type { FormIssue, Validator } from './types'

/**
 * Wrap any Standard-Schema-compatible schema (Zod 4, Valibot 1, ArkType 2,
 * …) as an Olas validator. Returns **all** issues as `FormIssue[]`, each
 * carrying the schema's own `path` — so a whole-form schema used as a
 * form-level validator routes each issue onto the matching field (T5.2),
 * and a leaf schema (whose issues have empty paths) still reports on the
 * field it's attached to. An empty array means "valid".
 *
 * Standard Schema validators may be sync or async; this wrapper threads
 * through whichever the schema returns — `Promise<FormIssue[]>` only when
 * the underlying validate call is itself async.
 *
 * `signal` is accepted to match the `Validator<T>` shape but isn't forwarded
 * — Standard Schema v1 has no cancellation surface.
 */
export function validator<I, O>(schema: StandardSchemaV1<I, O>): Validator<I> {
  return (value, signal) => {
    void signal
    const result = schema['~standard'].validate(value)
    if (result instanceof Promise) {
      return result.then(issuesFromResult)
    }
    return issuesFromResult(result)
  }
}

function issuesFromResult(result: {
  issues?: ReadonlyArray<StandardSchemaV1Issue>
}): FormIssue[] {
  if (result.issues === undefined || result.issues.length === 0) return []
  return result.issues.map((issue) => ({
    path: normalizeIssuePath(issue.path),
    message: issue.message ?? 'Invalid',
  }))
}

/**
 * Standard Schema issue paths are `(PropertyKey | { key: PropertyKey })[]`.
 * Flatten to the `(string | number)[]` shape `FormIssue` uses: numeric keys
 * stay numeric (array indices), everything else stringifies.
 */
function normalizeIssuePath(
  path: StandardSchemaV1Issue['path'],
): (string | number)[] {
  if (path === undefined) return []
  const out: (string | number)[] = []
  for (const seg of path) {
    const key = typeof seg === 'object' && seg !== null ? seg.key : seg
    out.push(typeof key === 'number' ? key : String(key))
  }
  return out
}

export { isStandardSchema, type StandardSchemaV1 } from './standard-schema'

const isEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  // Unchecked boolean fields are "empty" — `required` on a confirm-checkbox
  // should reject `false` the same way it rejects `''`.
  if (typeof value === 'boolean') return value === false
  return false
}

/** Reject empty values (undefined, null, empty string, empty array, false). */
export const required =
  <T>(message = 'Required'): Validator<T> =>
  (value) =>
    isEmpty(value) ? message : null

/** Reject strings / arrays shorter than `n`. Allows null/undefined (use with `required` to forbid). */
export const minLength =
  (n: number, message?: string): Validator<string | readonly unknown[]> =>
  (value) => {
    if (value == null) return null
    if (value.length >= n) return null
    return message ?? `Must be at least ${n} characters`
  }

/** Reject strings / arrays longer than `n`. */
export const maxLength =
  (n: number, message?: string): Validator<string | readonly unknown[]> =>
  (value) => {
    if (value == null) return null
    if (value.length <= n) return null
    return message ?? `Must be no more than ${n} characters`
  }

/** Reject numbers less than `n`. */
export const min =
  (n: number, message?: string): Validator<number> =>
  (value) => {
    if (value == null) return null
    if (value >= n) return null
    return message ?? `Must be at least ${n}`
  }

/** Reject numbers greater than `n`. */
export const max =
  (n: number, message?: string): Validator<number> =>
  (value) => {
    if (value == null) return null
    if (value <= n) return null
    return message ?? `Must be no more than ${n}`
  }

// RFC-5322-light. Pragmatic, not exhaustive — production forms should
// rely on server-side validation for definitive answers.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Reject strings that don't look like an email. Empty / null pass (use with `required` to forbid). */
export const email =
  (message = 'Invalid email address'): Validator<string> =>
  (value) => {
    if (value == null || value === '') return null
    return EMAIL_RE.test(value) ? null : message
  }

/** Reject strings that don't match the supplied `RegExp`. */
export const pattern =
  (re: RegExp, message = 'Invalid format'): Validator<string> =>
  (value) => {
    if (value == null || value === '') return null
    return re.test(value) ? null : message
  }
