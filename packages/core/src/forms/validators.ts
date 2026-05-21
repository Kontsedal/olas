import { isStandardSchema, type StandardSchemaV1 } from './standard-schema'
import type { Validator } from './types'

/**
 * Wrap any Standard-Schema-compatible schema (Zod 4, Valibot 1, ArkType 2,
 * …) as an Olas validator. The validator returns the first issue's message
 * on failure (or `'Invalid'` if no issues are produced), `null` on success.
 *
 * Standard Schema validators may be sync or async; this wrapper threads
 * through whichever the schema returns — `Promise<string|null>` only when
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
      return result.then(messageFromResult)
    }
    return messageFromResult(result)
  }
}

function messageFromResult(result: { issues?: ReadonlyArray<{ message: string }> }): string | null {
  if (result.issues === undefined || result.issues.length === 0) return null
  return result.issues[0]?.message ?? 'Invalid'
}

export { isStandardSchema, type StandardSchemaV1 } from './standard-schema'

const isEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** Reject empty values (undefined, null, empty string, empty array). */
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
