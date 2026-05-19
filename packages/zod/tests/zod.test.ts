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
})
