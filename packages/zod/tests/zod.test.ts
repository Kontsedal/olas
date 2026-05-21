import { createRoot, defineController } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { formFromZod, zodValidator, zodValidatorAsync } from '../src'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('zodValidator', () => {
  test('passes a valid value', async () => {
    const v = zodValidator(z.string().min(3))
    const sig = new AbortController().signal
    expect(await v('hello', sig)).toBeNull()
  })

  test('rejects an invalid value with the first Zod issue message', async () => {
    const v = zodValidator(z.string().min(3))
    const sig = new AbortController().signal
    const msg = await v('hi', sig)
    expect(typeof msg).toBe('string')
    expect(msg).toMatch(/3|at least/i)
  })

  test('zodValidatorAsync handles async refinements', async () => {
    const schema = z.string().refine(async (v) => v === 'ok', { message: 'must be ok' })
    const v = zodValidatorAsync(schema)
    const sig = new AbortController().signal
    expect(await v('ok', sig)).toBeNull()
    expect(await v('no', sig)).toBe('must be ok')
  })
})

describe('formFromZod', () => {
  test('builds a form whose value matches z.infer<schema>', () => {
    const schema = z.object({
      name: z.string().min(1).default('Alice'),
      age: z.number().int().default(0),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({ name: 'Alice', age: 0 })
    root.dispose()
  })

  test('nested z.object becomes a nested Form', () => {
    const schema = z.object({
      name: z.string(),
      address: z.object({
        street: z.string(),
        city: z.string(),
      }),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema, {
        initials: {
          name: 'Bob',
          address: { street: 'Main', city: 'Springfield' },
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({
      name: 'Bob',
      address: { street: 'Main', city: 'Springfield' },
    })
    root.dispose()
  })

  test('z.array becomes a FieldArray', async () => {
    const schema = z.object({
      tags: z.array(z.string().min(1)),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema, { initials: { tags: ['hello', 'world'] } }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({ tags: ['hello', 'world'] })
    expect(root.form.isValid.value).toBe(true)
    root.dispose()
  })

  test('extraValidators attaches an additional async rule on a specific leaf', async () => {
    const schema = z.object({
      title: z.string().min(1),
      address: z.object({ street: z.string() }),
    })
    const reservedTitles = new Set(['admin', 'root'])
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema, {
        initials: { title: 'admin', address: { street: 'Main' } },
        extraValidators: {
          title: (value) => (reservedTitles.has(value as string) ? 'title is reserved' : null),
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()

    const titleField = (root.form.fields as { title: { errors: { value: string[] } } }).title
    expect(titleField.errors.value).toContain('title is reserved')

    // Sibling field unaffected.
    const street = (
      root.form.fields as {
        address: { fields: { street: { errors: { value: string[] } } } }
      }
    ).address.fields.street
    expect(street.errors.value).toEqual([])

    root.dispose()
  })

  test('lifts root-level z.object().refine() into a form-level validator', async () => {
    // Cross-field check: confirm must match password. Lives at the root,
    // not on either leaf — a leaf-level `zodValidator(z.string())` can't
    // see the sibling.
    const schema = z
      .object({
        password: z.string().min(1),
        confirm: z.string().min(1),
      })
      .refine((v) => v.password === v.confirm, { message: 'passwords must match' })

    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema as unknown as z.ZodObject<z.ZodRawShape>, {
        initials: { password: 'abc', confirm: 'xyz' },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()

    expect(root.form.isValid.value).toBe(false)
    // Root issue surfaces on the form, not on any leaf.
    expect(root.form.topLevelErrors.value).toContain('passwords must match')
    // Sibling leaves stay clean (they each satisfy their own schema).
    const fields = root.form.fields as unknown as {
      password: { errors: { value: string[] } }
      confirm: { errors: { value: string[] } }
    }
    expect(fields.password.errors.value).toEqual([])
    expect(fields.confirm.errors.value).toEqual([])

    root.dispose()
  })

  test('extraValidators on a nested leaf via dotted path', async () => {
    const schema = z.object({
      address: z.object({ city: z.string() }),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema, {
        initials: { address: { city: 'forbidden' } },
        extraValidators: {
          'address.city': (value) => (value === 'forbidden' ? 'no go' : null),
        },
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()

    const city = (
      root.form.fields as { address: { fields: { city: { errors: { value: string[] } } } } }
    ).address.fields.city
    expect(city.errors.value).toContain('no go')

    root.dispose()
  })

  test('zod validators populate per-field errors', async () => {
    const schema = z.object({
      name: z.string().min(1),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema, { initials: { name: '' } }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.form.isValid.value).toBe(false)
    // We can't statically know `fields.name` is a Field — narrow:
    const nameField = (root.form.fields as { name: { errors: { value: string[] } } }).name
    expect(nameField.errors.value.length).toBeGreaterThan(0)
    root.dispose()
  })

  test('unwraps z.optional and z.nullable to infer the leaf initial', () => {
    const schema = z.object({
      maybe: z.optional(z.string()),
      nullable: z.nullable(z.number()),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    // optional/nullable have no Zod default → defaultInitial returns ''
    // for the inner string, 0 for the inner number.
    expect(root.form.value.value).toEqual({ maybe: '', nullable: 0 })
    root.dispose()
  })

  test('defaultInitial covers boolean / array / enum leaves', () => {
    const schema = z.object({
      flag: z.boolean(),
      tags: z.array(z.string()),
      kind: z.enum(['a', 'b', 'c']),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({ flag: false, tags: [], kind: 'a' })
    root.dispose()
  })

  test('honors function-form z.default()', () => {
    const schema = z.object({
      now: z.number().default(() => 42),
    })
    const def = defineController((ctx) => ({
      form: formFromZod(ctx, schema),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({ now: 42 })
    root.dispose()
  })
})

