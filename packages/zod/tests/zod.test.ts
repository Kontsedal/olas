import { createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createZodForm, zodValidator, zodValidatorAsync } from '../src'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('zodValidator', () => {
  test('passes a valid value (empty issue array)', async () => {
    const v = zodValidator(z.string().min(3))
    const sig = new AbortController().signal
    expect(await v('hello', sig)).toEqual([])
  })

  test('rejects an invalid value with a FormIssue carrying the Zod message', async () => {
    // Since T5.2, the Standard-Schema adapter returns FormIssue[] (path +
    // message) so whole-form schemas can route onto fields. A bare string
    // schema produces one empty-path issue.
    const v = zodValidator(z.string().min(3))
    const sig = new AbortController().signal
    const issues = await v('hi', sig)
    expect(Array.isArray(issues)).toBe(true)
    const list = issues as Array<{ path: (string | number)[]; message: string }>
    expect(list).toHaveLength(1)
    expect(list[0]?.path).toEqual([])
    expect(list[0]?.message).toMatch(/3|at least|small/i)
  })

  test('zodValidatorAsync handles async refinements', async () => {
    const schema = z.string().refine(async (v) => v === 'ok', { message: 'must be ok' })
    const v = zodValidatorAsync(schema)
    const sig = new AbortController().signal
    expect(await v('ok', sig)).toBeNull()
    expect(await v('no', sig)).toBe('must be ok')
  })
})

describe('createZodForm', () => {
  test('builds a form whose value matches z.infer<schema>', () => {
    const schema = z.object({
      name: z.string().min(1).default('Alice'),
      age: z.number().int().default(0),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value.value).toEqual({ name: 'Alice', age: 0 })
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
      form: createZodForm(ctx, schema, {
        initial: {
          name: 'Bob',
          address: { street: 'Main', city: 'Springfield' },
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value.value).toEqual({
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
      form: createZodForm(ctx, schema, { initial: { tags: ['hello', 'world'] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value.value).toEqual({ tags: ['hello', 'world'] })
    expect(root.api.form.isValid.value).toBe(true)
    root.dispose()
  })

  test('extraValidators attaches an additional async rule on a specific leaf', async () => {
    const schema = z.object({
      title: z.string().min(1),
      address: z.object({ street: z.string() }),
    })
    const reservedTitles = new Set(['admin', 'root'])
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, {
        initial: { title: 'admin', address: { street: 'Main' } },
        extraValidators: {
          title: (value) => (reservedTitles.has(value as string) ? 'title is reserved' : null),
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    const titleField = (root.api.form.fields as { title: { errors: { value: string[] } } }).title
    expect(titleField.errors.value).toContain('title is reserved')

    // Sibling field unaffected.
    const street = (
      root.api.form.fields as {
        address: { fields: { street: { errors: { value: string[] } } } }
      }
    ).address.fields.street
    expect(street.errors.value).toEqual([])

    root.dispose()
  })

  test('an extraValidators path at an array applies to every element', async () => {
    // A path names a position in the SCHEMA and an array adds no segment to
    // it, so `'tags'` reaches each tag field — there is no path that
    // addresses the FieldArray itself. Pinned because the two readings are
    // easy to confuse and only this one is implemented.
    const schema = z.object({ tags: z.array(z.string().min(1)) })
    const seen: unknown[] = []
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, {
        initial: { tags: ['ok', 'banned'] },
        extraValidators: {
          tags: (value) => {
            seen.push(value)
            return value === 'banned' ? 'tag is banned' : null
          },
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    const items = root.api.form.fields.tags.items.value
    expect(items).toHaveLength(2)
    // Each element ran the validator with its OWN value, not with the array.
    expect(seen).toEqual(['ok', 'banned'])
    expect(items[0]?.errors.value).toEqual([])
    expect(items[1]?.errors.value).toContain('tag is banned')

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
      form: createZodForm(ctx, schema as unknown as z.ZodObject<z.ZodRawShape>, {
        initial: { password: 'abc', confirm: 'xyz' },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    expect(root.api.form.isValid.value).toBe(false)
    // Root issue surfaces on the form, not on any leaf.
    expect(root.api.form.topLevelErrors.value).toContain('passwords must match')
    // Sibling leaves stay clean (they each satisfy their own schema).
    const fields = root.api.form.fields as unknown as {
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
      form: createZodForm(ctx, schema, {
        initial: { address: { city: 'forbidden' } },
        extraValidators: {
          'address.city': (value) => (value === 'forbidden' ? 'no go' : null),
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    const city = (
      root.api.form.fields as { address: { fields: { city: { errors: { value: string[] } } } } }
    ).address.fields.city
    expect(city.errors.value).toContain('no go')

    root.dispose()
  })

  test('zod validators populate per-field errors', async () => {
    const schema = z.object({
      name: z.string().min(1),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { name: '' } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.form.isValid.value).toBe(false)
    // We can't statically know `fields.name` is a Field — narrow:
    const nameField = (root.api.form.fields as { name: { errors: { value: string[] } } }).name
    expect(nameField.errors.value.length).toBeGreaterThan(0)
    root.dispose()
  })

  test('unwraps z.optional and z.nullable to infer the leaf initial', () => {
    const schema = z.object({
      maybe: z.optional(z.string()),
      nullable: z.nullable(z.number()),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    // optional/nullable have no Zod default → defaultInitial returns ''
    // for the inner string, 0 for the inner number.
    expect(root.api.form.value.value).toEqual({ maybe: '', nullable: 0 })
    root.dispose()
  })

  test('defaultInitial covers boolean / array / enum leaves', () => {
    const schema = z.object({
      flag: z.boolean(),
      tags: z.array(z.string()),
      kind: z.enum(['a', 'b', 'c']),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value.value).toEqual({ flag: false, tags: [], kind: 'a' })
    root.dispose()
  })

  test('honors function-form z.default()', () => {
    const schema = z.object({
      now: z.number().default(() => 42),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value.value).toEqual({ now: 42 })
    root.dispose()
  })
})

// ─── T6.5: async abort-race hygiene, dual-copy warn, defaultInitial gaps ─────

describe('zodValidatorAsync — abort-race cleanup (T6.5)', () => {
  test('removes its abort listener after a completed validation (no leak / late rejection)', async () => {
    const schema = z.string().refine(async () => true, { message: 'nope' })
    const v = zodValidatorAsync(schema)
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const result = await v('anything', controller.signal)
    expect(result).toBeNull()
    // The `abort` listener registered for the race must be cleaned up on the
    // happy path — otherwise a later abort rejects a promise nothing awaits.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    // Aborting AFTER completion must be a no-op (listener already gone).
    controller.abort()
    await flush()
  })
})

describe('createZodForm — duplicate zod copy detection (T6.5)', () => {
  test('warns when a nested schema is not an instanceof this package’s zod', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A schema-shaped object from "another zod copy": has a `def` marker but
      // fails every `instanceof z.ZodX` check against the zod we import.
      const foreign = { def: { type: 'object', shape: {} } } as unknown as z.ZodType
      const schema = z.object({ nested: foreign })
      const def = defineController((ctx) => ({
        form: createZodForm(ctx, schema as z.ZodObject<z.ZodRawShape>),
      }))
      const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/duplicate zod|two copies|instanceof/i),
      )
      root.dispose()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('createZodForm — defaultInitial gaps (T6.5)', () => {
  test('ZodDate → undefined; transform introspects input; union → undefined', () => {
    const schema = z.object({
      when: z.date(),
      len: z.string().transform((s) => s.length),
      either: z.union([z.string(), z.number()]),
    })
    const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const fields = root.api.form.fields as unknown as {
      when: { value: unknown }
      len: { value: unknown }
      either: { value: unknown }
    }
    expect(fields.when.value).toBeUndefined() // was null (wrong for a Date field)
    expect(fields.len.value).toBe('') // transform → the INPUT (string) default
    expect(fields.either.value).toBeUndefined() // union → undefined fallback
    root.dispose()
  })
})

describe('createZodForm — a function initial is tracked', () => {
  const schema = z.object({
    name: z.string().default('anon'),
    address: z.object({ city: z.string() }),
  })

  test('a clean form re-seats when the tracked source changes', () => {
    const seed = signal<{ name: string; address: { city: string } } | undefined>(undefined)
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: () => seed.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    // No source value yet: every leaf starts at its Zod default or empty value.
    expect(root.api.form.value.value).toEqual({ name: 'anon', address: { city: '' } })
    seed.set({ name: 'Ada', address: { city: 'London' } })
    expect(root.api.form.value.value).toEqual({ name: 'Ada', address: { city: 'London' } })
    expect(root.api.form.isDirty.value).toBe(false)
    root.dispose()
  })

  test('a dirty form keeps the user edit by default, and resetOnInitialChange overrides it', () => {
    const seed = signal({ name: 'Ada', address: { city: 'London' } })
    const def = defineController((ctx) => ({
      kept: createZodForm(ctx, schema, { initial: () => seed.value }),
      reseated: createZodForm(ctx, schema, {
        initial: () => seed.value,
        resetOnInitialChange: 'always',
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const city = (form: typeof root.api.kept) =>
      (form.fields as { address: { fields: { city: { set(v: string): void; value: string } } } })
        .address.fields.city
    city(root.api.kept).set('Paris')
    city(root.api.reseated).set('Paris')
    seed.set({ name: 'Grace', address: { city: 'Arlington' } })
    expect(city(root.api.kept).value).toBe('Paris')
    expect(city(root.api.reseated).value).toBe('Arlington')
    root.dispose()
  })
})
