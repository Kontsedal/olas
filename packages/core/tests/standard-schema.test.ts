import { describe, expect, test } from 'vitest'
import { isStandardSchema, type StandardSchemaV1, validator } from '../src/forms'

/**
 * Standard-Schema-v1 surface validation. We don't pull in Zod/Valibot/ArkType
 * as test deps — instead, hand-roll the smallest schemas that conform to the
 * `~standard.validate(value)` contract. That keeps the test focused on the
 * adapter (`validator(...)`) rather than on any single library.
 */

const stringSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (typeof value === 'string' && value.length > 0) return { value }
      return { issues: [{ message: 'must be non-empty string' }] }
    },
  },
}

const asyncEmailSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      // Simulate an async validator (e.g. `.refine(async ...)`).
      await Promise.resolve()
      if (typeof value === 'string' && /@/.test(value)) return { value }
      return { issues: [{ message: 'invalid email' }, { message: 'second' }] }
    },
  },
}

describe('isStandardSchema', () => {
  test('true for objects with a ~standard.validate method', () => {
    expect(isStandardSchema(stringSchema)).toBe(true)
  })

  test('false for non-objects and objects without ~standard', () => {
    expect(isStandardSchema(null)).toBe(false)
    expect(isStandardSchema(undefined)).toBe(false)
    expect(isStandardSchema('string')).toBe(false)
    expect(isStandardSchema({})).toBe(false)
    expect(isStandardSchema({ '~standard': {} })).toBe(false)
  })
})

describe('validator(schema)', () => {
  const signal = new AbortController().signal

  test('returns null on success (sync schema)', () => {
    const v = validator(stringSchema)
    expect(v('hello', signal)).toBeNull()
  })

  test('returns the first issue message on failure (sync schema)', () => {
    const v = validator(stringSchema)
    expect(v('', signal)).toBe('must be non-empty string')
  })

  test('non-string value yields the schema error', () => {
    const v = validator(stringSchema)
    // The validator's input type is `unknown` at runtime — Standard Schema
    // accepts whatever and rejects in its `validate`.
    expect((v as (v: unknown, s: AbortSignal) => unknown)(42, signal)).toBe(
      'must be non-empty string',
    )
  })

  test('returns a Promise when the schema is async', async () => {
    const v = validator(asyncEmailSchema)
    const r = v('not-an-email', signal)
    expect(r).toBeInstanceOf(Promise)
    expect(await r).toBe('invalid email')
  })

  test('async schema resolves to null on success', async () => {
    const v = validator(asyncEmailSchema)
    expect(await v('a@b.com', signal)).toBeNull()
  })

  test('"Invalid" fallback if schema produces an empty issues array', () => {
    // Pathological schema — issues present but empty. Defensive default.
    const odd: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate() {
          return { issues: [] }
        },
      },
    }
    // Empty issues array means "valid" per the spec — adapter returns null.
    const v = validator(odd)
    expect(v('anything', signal)).toBeNull()
  })

  test('message defaults to "Invalid" if an issue is missing its message field', () => {
    const odd: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate() {
          return { issues: [{} as unknown as { message: string }] }
        },
      },
    }
    const v = validator(odd)
    expect(v('anything', signal)).toBe('Invalid')
  })
})
