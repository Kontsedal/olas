import { createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createZodForm, rootOnlyZodValidator, zodValidator, zodValidatorAsync } from '../src'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Wait out every pending microtask: a Zod async parse takes more than `flush` covers. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
    expect(root.api.form.value).toEqual({ name: 'Alice', age: 0 })
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
    expect(root.api.form.value).toEqual({
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
    expect(root.api.form.value).toEqual({ tags: ['hello', 'world'] })
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
    expect(root.api.form.value).toEqual({ maybe: '', nullable: 0 })
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
    expect(root.api.form.value).toEqual({ flag: false, tags: [], kind: 'a' })
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
    expect(root.api.form.value).toEqual({ now: 42 })
    root.dispose()
  })
})

// ─── Rules on objects and arrays: enforced, routed by path, reported once ────

describe('createZodForm — an array-level rule is enforced on the FieldArray', () => {
  test('z.array(...).min(3) lands in the array’s topLevelErrors, and adding items clears it', async () => {
    const schema = z.object({
      tags: z.array(z.string().min(1)).min(3, 'Add at least three tags'),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { tags: ['a'] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const { form } = root.api
    const tags = form.fields.tags

    expect(form.isValid.value).toBe(false)
    expect(tags.isValid.value).toBe(false)
    expect(tags.topLevelErrors.value).toEqual(['Add at least three tags'])
    // The message sits on the array, not on the form or on the item.
    expect(form.topLevelErrors.value).toEqual([])
    expect(tags.items.value[0]?.errors.value).toEqual([])
    expect(form.flatErrors.value).toEqual([{ path: 'tags', errors: ['Add at least three tags'] }])

    tags.add('b')
    tags.add('c')
    await flush()
    expect(tags.topLevelErrors.value).toEqual([])
    expect(form.isValid.value).toBe(true)

    root.dispose()
  })

  test('an array message and an item message each land once, on their own node', async () => {
    const schema = z.object({
      tags: z.array(z.string().min(1, 'Tag cannot be empty')).min(3, 'Add at least three tags'),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { tags: [''] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const tags = root.api.form.fields.tags

    expect(tags.topLevelErrors.value).toEqual(['Add at least three tags'])
    expect(tags.items.value[0]?.errors.value).toEqual(['Tag cannot be empty'])

    root.dispose()
  })

  test('an array .refine(...) over the whole list lands on the FieldArray', async () => {
    const unique = (list: readonly { sku: string }[]) =>
      new Set(list.map((line) => line.sku)).size === list.length
    const schema = z.object({
      lines: z.array(z.object({ sku: z.string().min(1) })).refine(unique, 'Each SKU once'),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { lines: [{ sku: 'A' }, { sku: 'A' }] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const lines = root.api.form.fields.lines

    expect(lines.topLevelErrors.value).toEqual(['Each SKU once'])
    lines.items.value[1]?.fields.sku.set('B')
    await flush()
    expect(lines.topLevelErrors.value).toEqual([])
    expect(root.api.form.isValid.value).toBe(true)

    root.dispose()
  })
})

describe('createZodForm — a root .refine with a path lands on the field it names', () => {
  const passwords = z
    .object({
      password: z.string().min(1, 'Enter a password'),
      confirm: z.string().min(1, 'Confirm your password'),
    })
    .refine((v) => v.password === v.confirm, {
      path: ['confirm'],
      message: 'Passwords must match',
    })

  test('the message is on confirm, not on the form, and fixing the value clears it', async () => {
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, passwords, { initial: { password: 'abc', confirm: 'xyz' } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const { form } = root.api

    expect(form.fields.confirm.errors.value).toEqual(['Passwords must match'])
    expect(form.fields.password.errors.value).toEqual([])
    expect(form.topLevelErrors.value).toEqual([])
    expect(form.isValid.value).toBe(false)

    form.fields.confirm.set('abc')
    await flush()
    expect(form.fields.confirm.errors.value).toEqual([])
    expect(form.isValid.value).toBe(true)

    root.dispose()
  })

  test('a leaf failure and the refine at the same path each report once', async () => {
    // The whole-schema parse reports confirm's own `.min(1)` too. The leaf's
    // validator already shows it, so the form-level run drops that copy.
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, passwords, { initial: { password: 'abc', confirm: '' } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    expect(root.api.form.fields.confirm.errors.value).toEqual([
      'Confirm your password',
      'Passwords must match',
    ])

    root.dispose()
  })

  test('a refine message the leaf already shows is not repeated', async () => {
    const schema = z
      .object({ code: z.string().min(1, 'Required') })
      .refine((v) => v.code.length > 0, { path: ['code'], message: 'Required' })
    const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    expect(root.api.form.fields.code.errors.value).toEqual(['Required'])

    root.dispose()
  })

  test('a superRefine issue under a leaf lands on that leaf', async () => {
    // A tuple is one leaf field, so a path into it is cut back to the field.
    const schema = z.object({ range: z.tuple([z.number(), z.number()]) }).superRefine((v, ctx) => {
      if (v.range[1] < v.range[0]) {
        ctx.addIssue({ code: 'custom', path: ['range', 1], message: 'End before start' })
      }
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { range: [5, 1] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    expect(root.api.form.fields.range.errors.value).toEqual(['End before start'])
    expect(root.api.form.topLevelErrors.value).toEqual([])

    root.dispose()
  })

  test('a refine path the tree cannot resolve lands in form.topLevelErrors', async () => {
    const schema = z
      .object({ items: z.array(z.object({ name: z.string() })) })
      .refine(() => false, { path: ['missing'], message: 'No such key' })
      .refine(() => false, { path: ['items', 5, 'name'], message: 'No such item' })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { items: [{ name: 'a' }] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    expect(root.api.form.topLevelErrors.value).toEqual(['No such key', 'No such item'])

    root.dispose()
  })
})

describe('createZodForm — the documented examples hold', () => {
  test('README: a refine on confirm and a .min(3) on tags', async () => {
    const signupSchema = z
      .object({
        password: z.string().min(8),
        confirm: z.string().min(1, 'Confirm your password'),
        tags: z.array(z.string().min(1)).min(3, 'Add at least three tags'),
      })
      .refine((v) => v.password === v.confirm, {
        path: ['confirm'],
        message: 'Passwords must match',
      })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, signupSchema, {
        initial: { password: 'correct horse', confirm: 'correct hose', tags: ['a'] },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { form } = root.api

    // Read straight after construction, as the README does: a sync schema
    // routes its messages in the constructor.
    expect(form.fields.confirm.errors.value).toEqual(['Passwords must match'])
    expect(form.fields.tags.topLevelErrors.value).toEqual(['Add at least three tags'])
    expect(form.isValid.value).toBe(false)

    form.fields.confirm.set('')
    await flush()
    expect(form.fields.confirm.errors.value).toEqual([
      'Confirm your password',
      'Passwords must match',
    ])

    root.dispose()
  })

  test('API.md: a .min(1) on lines and a refine on total, with no initial', () => {
    const Order = z
      .object({
        lines: z.array(z.object({ sku: z.string().min(1) })).min(1, 'Add a line'),
        total: z.number(),
      })
      .refine((v) => v.total > 0, { path: ['total'], message: 'Total must be positive' })
    const def = defineController((ctx) => ({ form: createZodForm(ctx, Order) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    expect(root.api.form.fields.lines.topLevelErrors.value).toEqual(['Add a line'])
    expect(root.api.form.fields.total.errors.value).toEqual(['Total must be positive'])

    root.dispose()
  })
})

describe('createZodForm — rules deeper in the tree', () => {
  test('a nested object’s .refine lands on the nested form', async () => {
    const schema = z.object({
      trip: z
        .object({ from: z.string(), to: z.string() })
        .refine((v) => v.from !== v.to, 'Pick two different cities'),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { trip: { from: 'Oslo', to: 'Oslo' } } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const { form } = root.api

    expect(form.fields.trip.topLevelErrors.value).toEqual(['Pick two different cities'])
    expect(form.topLevelErrors.value).toEqual([])
    expect(form.isValid.value).toBe(false)

    root.dispose()
  })

  test('a rule on an .optional() wrapper around an object is found', async () => {
    const schema = z.object({
      extra: z
        .object({ note: z.string() })
        .optional()
        .refine((v) => v?.note !== 'x', 'No x'),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { extra: { note: 'x' } } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    expect(root.api.form.fields.extra.topLevelErrors.value).toEqual(['No x'])

    root.dispose()
  })

  test('an item object’s .refine with a path lands on that item’s field', async () => {
    const schema = z.object({
      people: z.array(
        z
          .object({ name: z.string() })
          .refine((v) => v.name !== 'root', { path: ['name'], message: 'Name is reserved' }),
      ),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, {
        initial: { people: [{ name: 'ada' }, { name: 'root' }] },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const people = root.api.form.fields.people.items.value

    expect(people[0]?.fields.name.errors.value).toEqual([])
    expect(people[1]?.fields.name.errors.value).toEqual(['Name is reserved'])

    root.dispose()
  })

  test('a recursive schema does not loop the rule walk', async () => {
    // Zod 4 builds a recursive object through a getter, which returns a new
    // array each time it is read. The walk must stop at the object it has
    // seen, with a rule deep in the recursion and without one.
    const Plain = z.object({
      name: z.string(),
      get children() {
        return z.array(Plain)
      },
    })
    const Capped = z.object({
      name: z.string(),
      get children() {
        return z.array(Capped).max(1, 'One child at most')
      },
    })
    const def = defineController((ctx) => ({
      plain: createZodForm(ctx, Plain as unknown as z.ZodObject<z.ZodRawShape>),
      capped: createZodForm(ctx, Capped as unknown as z.ZodObject<z.ZodRawShape>, {
        initial: { name: 'a', children: [{ name: 'b' }, { name: 'c' }] },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    expect(root.api.plain.isValid.value).toBe(true)
    const children = root.api.capped.fields.children as unknown as {
      topLevelErrors: { value: string[] }
    }
    expect(children.topLevelErrors.value).toEqual(['One child at most'])

    root.dispose()
  })
})

describe('createZodForm — async rules', () => {
  test('an async root .refine is awaited, and the form reads validating meanwhile', async () => {
    let release: (ok: boolean) => void = () => {}
    const schema = z.object({ name: z.string() }).refine(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      'Name is taken',
    )
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { name: 'ada' } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const { form } = root.api

    expect(form.isValidating.value).toBe(true)
    release(false)
    await settle()
    expect(form.isValidating.value).toBe(false)
    expect(form.topLevelErrors.value).toEqual(['Name is taken'])

    root.dispose()
  })

  test('an async leaf under a structural rule reports its own message once', async () => {
    // The leaf's async refine makes the whole-schema parse async, and the
    // check for what the leaf already shows is async too.
    const schema = z.object({
      title: z.string().refine(async (v) => v !== 'taken', 'Title is taken'),
      tags: z.array(z.string()).min(1, 'Add a tag'),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { title: 'taken', tags: [] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await settle()
    const { form } = root.api

    expect(form.fields.title.errors.value).toEqual(['Title is taken'])
    expect(form.fields.tags.topLevelErrors.value).toEqual(['Add a tag'])

    root.dispose()
  })
})

describe('createZodForm — the whole-schema parse costs only the schemas that need it', () => {
  // Every Zod parse, sync or async, safe or throwing, enters through the
  // schema's own `_zod.run`. A spy on the ROOT schema's `run` counts the
  // whole-schema parses; a leaf validator runs its leaf's schema, not this.
  test('a plain schema is never parsed as a whole', async () => {
    const schema = z.object({
      name: z.string().min(1),
      address: z.object({ city: z.string().min(1) }),
      tags: z.array(z.string().min(1)),
    })
    const run = vi.spyOn(schema._zod, 'run')
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { tags: ['a'] } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { form } = root.api

    form.fields.name.set('Ada')
    form.fields.address.fields.city.set('')
    form.fields.tags.add('')
    await form.validate()
    await flush()

    // The leaves did validate…
    expect(form.fields.address.fields.city.errors.value).toHaveLength(1)
    expect(form.isValid.value).toBe(false)
    // …and the whole schema never ran.
    expect(run).not.toHaveBeenCalled()

    root.dispose()
  })

  test('a schema with an object or array rule is parsed as a whole on each change', async () => {
    const schema = z
      .object({ a: z.string(), b: z.string() })
      .refine((v) => v.a !== v.b, 'a and b must differ')
    const run = vi.spyOn(schema._zod, 'run')
    const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const afterBuild = run.mock.calls.length

    expect(afterBuild).toBe(1)
    root.api.form.fields.a.set('x')
    expect(run.mock.calls.length).toBe(afterBuild + 1)

    root.dispose()
  })
})

describe('rootOnlyZodValidator', () => {
  test('reports the first path-less issue and drops every issue with a path', () => {
    const sig = new AbortController().signal
    const schema = z
      .object({ a: z.string().min(1) })
      .refine((v) => v.a !== 'bad', 'root rule')
      .refine((v) => v.a !== 'bad', { path: ['a'], message: 'on a' })
    const v = rootOnlyZodValidator(schema)

    expect(v({ a: 'bad' }, sig)).toBe('root rule')
    // A leaf failure alone has a path, so there is nothing to report.
    expect(v({ a: '' }, sig)).toBeNull()
    expect(v({ a: 'ok' }, sig)).toBeNull()
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
  test('warns once when nested schemas are not an instanceof this package’s zod', () => {
    // The only foreign-schema test in this file: the warning is once per
    // module, so a foreign schema in an earlier test would use it up.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A schema-shaped object from "another zod copy": has a `def` marker but
      // fails every `instanceof z.ZodX` check against the zod we import.
      const foreign = () => ({ def: { type: 'object', shape: {} } }) as unknown as z.ZodType
      const schema = z.object({ nested: foreign(), other: foreign(), list: z.array(foreign()) })
      const def = defineController((ctx) => ({
        first: createZodForm(ctx, schema as z.ZodObject<z.ZodRawShape>, {
          initial: { list: [{}, {}] } as never,
        }),
        second: createZodForm(ctx, schema as z.ZodObject<z.ZodRawShape>),
      }))
      const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
      // Six foreign leaves across two forms, one warning.
      expect(warnSpy).toHaveBeenCalledTimes(1)
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
    expect(root.api.form.value).toEqual({ name: 'anon', address: { city: '' } })
    seed.set({ name: 'Ada', address: { city: 'London' } })
    expect(root.api.form.value).toEqual({ name: 'Ada', address: { city: 'London' } })
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

describe('createZodForm — initial values match what Zod parses', () => {
  test('a default under .optional() or .nullable() seeds the field', () => {
    const schema = z.object({
      a: z.string().default('a').optional(),
      b: z.number().default(5).nullable(),
    })
    const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value).toEqual(schema.parse({}))
    root.dispose()
  })

  test('a function-valued default seeds the function, not its result', () => {
    const cb = () => 7
    const schema = z.object({ fn: z.custom<() => number>().default(() => cb) })
    const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect((root.api.form.value as { fn: unknown }).fn).toBe(cb)
    root.dispose()
  })

  test('a default on an array or an object seeds the FieldArray or the nested Form', () => {
    const schema = z.object({
      tags: z.array(z.string()).default(['inbox']),
      address: z.object({ city: z.string() }).default({ city: 'Kyiv' }),
      optionalTags: z.array(z.string()).default(['a', 'b']).optional(),
    })
    const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value).toEqual(schema.parse({}))
    expect(root.api.form.fields.tags.items.value).toHaveLength(1)
    // The default is where reset goes back to.
    root.api.form.fields.tags.add('extra')
    root.api.form.fields.address.fields.city.set('Lviv')
    root.api.form.reset()
    expect(root.api.form.value).toEqual(schema.parse({}))
    root.dispose()
  })

  test('an initial value still wins over an array or object default', () => {
    const schema = z.object({
      tags: z.array(z.string()).default(['inbox']),
      address: z.object({ city: z.string() }).default({ city: 'Kyiv' }),
    })
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, schema, { initial: { tags: [], address: { city: 'Odesa' } } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value).toEqual({ tags: [], address: { city: 'Odesa' } })
    root.dispose()
  })

  test('a numeric enum seeds its first option', () => {
    const schema = z.object({ level: z.enum({ Low: 1, High: 2 }) })
    const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value).toEqual({ level: 1 })
    root.dispose()
  })
})
