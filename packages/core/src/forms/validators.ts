import type { Validator } from './types'

const isEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

export const required =
  <T>(message = 'Required'): Validator<T> =>
  (value) =>
    isEmpty(value) ? message : null

export const minLength =
  (n: number, message?: string): Validator<string | readonly unknown[]> =>
  (value) => {
    if (value == null) return null
    if (value.length >= n) return null
    return message ?? `Must be at least ${n} characters`
  }

export const maxLength =
  (n: number, message?: string): Validator<string | readonly unknown[]> =>
  (value) => {
    if (value == null) return null
    if (value.length <= n) return null
    return message ?? `Must be no more than ${n} characters`
  }

export const min =
  (n: number, message?: string): Validator<number> =>
  (value) => {
    if (value == null) return null
    if (value >= n) return null
    return message ?? `Must be at least ${n}`
  }

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

export const email =
  (message = 'Invalid email address'): Validator<string> =>
  (value) => {
    if (value == null || value === '') return null
    return EMAIL_RE.test(value) ? null : message
  }

export const pattern =
  (re: RegExp, message = 'Invalid format'): Validator<string> =>
  (value) => {
    if (value == null || value === '') return null
    return re.test(value) ? null : message
  }
