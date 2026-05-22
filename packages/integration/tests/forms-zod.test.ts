/**
 * Scenario: end-to-end form lifecycle backed by a zod schema.
 *
 * - Schema-derived validators auto-attach to every leaf field.
 * - The user types a value that doesn't pass; submit() refuses to call
 *   the handler, marks every field touched, and returns ok:false.
 * - The user fixes the value; submit() calls the handler.
 * - The handler returns server-side validation errors; the form maps
 *   them via `form.setErrors` to the right leaves.
 * - reset() restores initials and clears dirty / errors.
 *
 * This is a controller-level (no DOM) verification of the contract
 * between olas-core forms and olas-zod's `formFromZod` helper.
 */

import { createRoot, defineController } from '@kontsedal/olas-core'
import { formFromZod } from '@kontsedal/olas-zod'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { settle } from './_helpers'

const userSchema = z.object({
  name: z.string().min(2, 'name too short'),
  email: z.email('not an email'),
  address: z.object({
    street: z.string().min(1, 'street required'),
    city: z.string().min(1, 'city required'),
  }),
})

type UserForm = z.infer<typeof userSchema>

describe('integration: forms + zod end-to-end', () => {
  test('invalid initial value blocks submit; valid edit unblocks it', async () => {
    const handler = vi.fn(async (value: UserForm) => ({ id: 'srv-1', ...value }))

    const def = defineController((ctx) => ({
      form: formFromZod(ctx, userSchema, {
        initials: {
          name: 'X', // too short
          email: 'not-an-email', // bad
          address: { street: 'Main', city: 'Sprawl' },
        },
      }),
    }))

    const root = createRoot(def, { deps: {} })
    await settle()

    type Fields = {
      name: { errors: { value: string[] }; set: (v: string) => void; touched: { value: boolean } }
      email: { errors: { value: string[] }; set: (v: string) => void; touched: { value: boolean } }
      address: { fields: { street: { errors: { value: string[] } } } }
    }
    const fields = root.form.fields as unknown as Fields

    // Initial validation: name and email are bad; submit must refuse.
    expect(fields.name.errors.value).toContain('name too short')
    expect(fields.email.errors.value).toContain('not an email')

    const blocked = await root.form.submit(handler)
    expect(blocked.ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    // Submit-blocked path marks every leaf as touched so the UI can show errors.
    expect(fields.name.touched.value).toBe(true)
    expect(fields.email.touched.value).toBe(true)

    // Fix the values; validators clear.
    fields.name.set('Alice')
    fields.email.set('alice@example.com')
    await settle()
    expect(fields.name.errors.value).toEqual([])
    expect(fields.email.errors.value).toEqual([])

    const ok = await root.form.submit(handler)
    expect(ok.ok).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      name: 'Alice',
      email: 'alice@example.com',
      address: { street: 'Main', city: 'Sprawl' },
    })

    root.dispose()
  })

  test('server-side validation errors map back to the right leaf via form.setErrors', async () => {
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, userSchema, {
        initials: {
          name: 'Alice',
          email: 'alice@example.com',
          address: { street: 'Main', city: 'Sprawl' },
        },
      }),
    }))

    const root = createRoot(def, { deps: {} })
    await settle()

    type FormApi = {
      setErrors: (errors: Record<string, string[]>) => void
      fields: {
        email: { errors: { value: string[] } }
        address: { fields: { city: { errors: { value: string[] } } } }
      }
    }
    const formApi = root.form as unknown as FormApi

    // Submit a value the schema accepts; the server complains.
    const result = await root.form.submit(async () => {
      // Simulate a 422 with field-level errors.
      formApi.setErrors({
        email: ['email already taken'],
        'address.city': ['city is not deliverable'],
      })
      throw new Error('422 Unprocessable Entity')
    })
    expect(result.ok).toBe(false)

    expect(formApi.fields.email.errors.value).toContain('email already taken')
    expect(formApi.fields.address.fields.city.errors.value).toContain('city is not deliverable')

    root.dispose()
  })

  test('cross-field zod refine() lifts to a form-level validator', async () => {
    const passwordSchema = z
      .object({
        password: z.string().min(8, 'min 8 chars'),
        confirm: z.string(),
      })
      .refine((v) => v.password === v.confirm, { message: 'passwords must match' })

    const def = defineController((ctx) => ({
      form: formFromZod(ctx, passwordSchema as unknown as z.ZodObject<z.ZodRawShape>, {
        initials: { password: 'abcdefgh', confirm: 'mismatch!' },
      }),
    }))

    const root = createRoot(def, { deps: {} })
    await settle()

    type FormApi = {
      topLevelErrors: { value: string[] }
      isValid: { value: boolean }
      fields: {
        confirm: { errors: { value: string[] }; set: (v: string) => void }
      }
    }
    const f = root.form as unknown as FormApi

    // Root refine lives at the form level, not on either leaf.
    expect(f.topLevelErrors.value).toContain('passwords must match')
    expect(f.isValid.value).toBe(false)
    expect(f.fields.confirm.errors.value).toEqual([])

    f.fields.confirm.set('abcdefgh')
    await settle()
    expect(f.topLevelErrors.value).toEqual([])
    expect(f.isValid.value).toBe(true)

    root.dispose()
  })

  test('reset clears dirty + restores initials + clears server errors', async () => {
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, userSchema, {
        initials: {
          name: 'Alice',
          email: 'alice@example.com',
          address: { street: 'Main', city: 'Sprawl' },
        },
      }),
    }))
    const root = createRoot(def, { deps: {} })
    await settle()

    type FormApi = {
      fields: {
        name: { value: string; set: (v: string) => void; isDirty: { value: boolean } }
      }
      isDirty: { value: boolean }
      setErrors: (errs: Record<string, string[]>) => void
      reset: () => void
    }
    const f = root.form as unknown as FormApi

    f.fields.name.set('Bob')
    f.setErrors({ name: ['server says no'] })
    await settle()
    expect(f.fields.name.value).toBe('Bob')
    expect(f.fields.name.isDirty.value).toBe(true)
    expect(f.isDirty.value).toBe(true)

    f.reset()
    await settle()
    expect(f.fields.name.value).toBe('Alice')
    expect(f.fields.name.isDirty.value).toBe(false)
    expect(f.isDirty.value).toBe(false)

    root.dispose()
  })
})
