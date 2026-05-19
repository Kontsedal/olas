import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { required } from '../src/forms/validators'

const emptyDeps = {}

describe('ctx.form — basic aggregation', () => {
  test('value aggregates leaf fields', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('Alice', [required()]),
        age: ctx.field<number>(30),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({ name: 'Alice', age: 30 })
    root.form.fields.name.set('Bob')
    expect(root.form.value.value).toEqual({ name: 'Bob', age: 30 })
    root.dispose()
  })

  test('nested forms aggregate recursively', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field('Alice'),
        address: ctx.form({
          street: ctx.field('Main'),
          city: ctx.field('Springfield'),
        }),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({
      name: 'Alice',
      address: { street: 'Main', city: 'Springfield' },
    })
    root.form.fields.address.fields.city.set('NYC')
    expect(root.form.value.value).toEqual({
      name: 'Alice',
      address: { street: 'Main', city: 'NYC' },
    })
    root.dispose()
  })

  test('errors aggregate per-field; isValid reflects whole tree', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('', [required()]),
        age: ctx.field(0),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.errors.value).toEqual({ name: ['Required'], age: undefined })
    expect(root.form.isValid.value).toBe(false)

    root.form.fields.name.set('Alice')
    expect(root.form.errors.value).toEqual({ name: undefined, age: undefined })
    expect(root.form.isValid.value).toBe(true)
    root.dispose()
  })

  test('set performs a batched deep-merge', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field('A'),
        nested: ctx.form({ x: ctx.field(1), y: ctx.field(2) }),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.set({ name: 'B', nested: { x: 10 } })
    expect(root.form.value.value).toEqual({ name: 'B', nested: { x: 10, y: 2 } })
    root.dispose()
  })

  test('markAllTouched + reset cascade', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('', [required()]),
        nested: ctx.form({ x: ctx.field<string>('', [required()]) }),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.markAllTouched()
    expect(root.form.fields.name.touched.value).toBe(true)
    expect(root.form.fields.nested.fields.x.touched.value).toBe(true)
    expect(root.form.touched.value).toBe(true)

    root.form.fields.name.set('x')
    expect(root.form.isDirty.value).toBe(true)

    root.form.reset()
    expect(root.form.isDirty.value).toBe(false)
    expect(root.form.touched.value).toBe(false)
    root.dispose()
  })

  test('validate() awaits children and returns overall isValid', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('', [required()]),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(await root.form.validate()).toBe(false)
    root.form.fields.name.set('Alice')
    expect(await root.form.validate()).toBe(true)
    root.dispose()
  })

  test('form options.initial does NOT start the form dirty', () => {
    // Regression: `applyPartial` previously called `Field.set(...)` for the
    // initial value, which marked dirty. Server-loaded forms were born dirty.
    const def = defineController((ctx) => ({
      form: ctx.form(
        {
          name: ctx.field<string>(''),
          email: ctx.field<string>(''),
          address: ctx.form({
            street: ctx.field<string>(''),
            city: ctx.field<string>(''),
          }),
        },
        {
          initial: {
            name: 'Ada',
            email: 'ada@example.com',
            address: { street: '1 Babbage St', city: 'London' },
          },
        },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    // Initial values applied
    expect(root.form.fields.name.value).toBe('Ada')
    expect(root.form.fields.address.fields.city.value).toBe('London')

    // Not dirty — top level or any leaf
    expect(root.form.isDirty.value).toBe(false)
    expect(root.form.fields.name.isDirty.value).toBe(false)
    expect(root.form.fields.address.fields.city.isDirty.value).toBe(false)
    root.dispose()
  })

  test('reset() with initial returns to the initial values, not empty', () => {
    // Regression: reset() called Field.reset() (which goes to ctor `initial`)
    // and then re-applied form.initial via set(), making the form dirty again.
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('') }, { initial: { name: 'Ada' } }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    root.form.fields.name.set('Bob')
    expect(root.form.fields.name.value).toBe('Bob')
    expect(root.form.isDirty.value).toBe(true)

    root.form.reset()
    expect(root.form.fields.name.value).toBe('Ada')
    expect(root.form.isDirty.value).toBe(false)
    root.dispose()
  })
})

describe('ctx.form — form-level validators', () => {
  test('topLevelErrors populated when cross-field rule fails', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form(
        {
          password: ctx.field(''),
          confirm: ctx.field(''),
        },
        {
          validators: [(v) => (v.password === v.confirm ? null : 'Passwords must match')],
        },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.fields.password.set('abc')
    await vi.waitFor(() => expect(root.form.topLevelErrors.value).toEqual(['Passwords must match']))
    expect(root.form.isValid.value).toBe(false)

    root.form.fields.confirm.set('abc')
    await vi.waitFor(() => expect(root.form.topLevelErrors.value).toEqual([]))
    expect(root.form.isValid.value).toBe(true)
    root.dispose()
  })
})

describe('ctx.form — flatErrors', () => {
  test('emits {path,errors} entries for leaves and form-level', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form(
        {
          name: ctx.field<string>('', [required()]),
          address: ctx.form({
            city: ctx.field<string>('', [required()]),
          }),
        },
        {
          validators: [(_v) => 'always wrong'],
        },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    // Wait for the always-wrong top-level + required leaf to land in flat.
    await vi.waitFor(() => {
      const f = root.form.flatErrors.value
      expect(f).toContainEqual({ path: '', errors: ['always wrong'] })
      expect(f).toContainEqual({ path: 'name', errors: ['Required'] })
    })
    const flat = root.form.flatErrors.value
    expect(flat).toContainEqual({ path: 'address.city', errors: ['Required'] })
    root.dispose()
  })
})

describe('ctx.fieldArray', () => {
  test('add/remove/insert/move/clear', () => {
    const def = defineController((ctx) => ({
      tags: ctx.fieldArray((initial) => ctx.field(initial ?? '')),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.tags.add('a')
    root.tags.add('b')
    root.tags.add('c')
    expect(root.tags.value.value).toEqual(['a', 'b', 'c'])
    expect(root.tags.size.value).toBe(3)

    root.tags.insert(1, 'x')
    expect(root.tags.value.value).toEqual(['a', 'x', 'b', 'c'])

    root.tags.remove(2)
    expect(root.tags.value.value).toEqual(['a', 'x', 'c'])

    root.tags.move(0, 2)
    expect(root.tags.value.value).toEqual(['x', 'c', 'a'])

    root.tags.clear()
    expect(root.tags.value.value).toEqual([])
    root.dispose()
  })

  test('arrays of sub-forms aggregate value/errors', () => {
    const def = defineController((ctx) => ({
      items: ctx.fieldArray((initial) =>
        ctx.form(
          {
            sku: ctx.field<string>('', [required()]),
            qty: ctx.field<number>(1),
          },
          { initial: initial as { sku?: string; qty?: number } | undefined },
        ),
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.items.add({ sku: 'A', qty: 2 })
    root.items.add({ sku: '', qty: 5 })
    expect(root.items.value.value).toEqual([
      { sku: 'A', qty: 2 },
      { sku: '', qty: 5 },
    ])
    expect(root.items.isValid.value).toBe(false) // second item's sku is empty

    const second = root.items.at(1) as unknown as { fields: { sku: { set: (v: string) => void } } }
    second.fields.sku.set('B')
    expect(root.items.isValid.value).toBe(true)
    root.dispose()
  })

  test('array-level validators populate topLevelErrors', async () => {
    const def = defineController((ctx) => ({
      tags: ctx.fieldArray(() => ctx.field(''), {
        validators: [(items) => (items.length >= 1 ? null : 'At least one')],
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.tags.topLevelErrors.value).toEqual(['At least one']))
    expect(root.tags.isValid.value).toBe(false)

    root.tags.add('hello')
    await vi.waitFor(() => expect(root.tags.topLevelErrors.value).toEqual([]))
    expect(root.tags.isValid.value).toBe(true)
    root.dispose()
  })

  test('initial items + reset re-populates', () => {
    const def = defineController((ctx) => ({
      tags: ctx.fieldArray((initial) => ctx.field(initial ?? ''), {
        initial: ['x', 'y'],
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.tags.value.value).toEqual(['x', 'y'])
    root.tags.add('z')
    root.tags.reset()
    expect(root.tags.value.value).toEqual(['x', 'y'])
    root.dispose()
  })
})
