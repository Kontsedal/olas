import { describe, expect, test, vi } from 'vitest'
import { createField, createFieldArray, createForm } from '../src'
import { createRoot, defineController } from '../src/controller'
import type { FormIssue } from '../src/forms'
import { required } from '../src/forms/validators'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

const emptyDeps = {}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ctx.form — basic aggregation', () => {
  test('value aggregates leaf fields', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, 'Alice', { validators: [required()] }),
        age: createField<number>(ctx, 30),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value).toEqual({ name: 'Alice', age: 30 })
    root.api.form.fields.name.set('Bob')
    expect(root.api.form.value).toEqual({ name: 'Bob', age: 30 })
    root.dispose()
  })

  test('nested forms aggregate recursively', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField(ctx, 'Alice'),
        address: createForm(ctx, {
          street: createField(ctx, 'Main'),
          city: createField(ctx, 'Springfield'),
        }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value).toEqual({
      name: 'Alice',
      address: { street: 'Main', city: 'Springfield' },
    })
    root.api.form.fields.address.fields.city.set('NYC')
    expect(root.api.form.value).toEqual({
      name: 'Alice',
      address: { street: 'Main', city: 'NYC' },
    })
    root.dispose()
  })

  test('errors aggregate per-field; isValid reflects whole tree', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, '', { validators: [required()] }),
        age: createField(ctx, 0),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.errors.value).toEqual({ name: ['Required'], age: undefined })
    expect(root.api.form.isValid.value).toBe(false)

    root.api.form.fields.name.set('Alice')
    expect(root.api.form.errors.value).toEqual({ name: undefined, age: undefined })
    expect(root.api.form.isValid.value).toBe(true)
    root.dispose()
  })

  test('set performs a batched deep-merge', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField(ctx, 'A'),
        nested: createForm(ctx, { x: createField(ctx, 1), y: createField(ctx, 2) }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.form.set({ name: 'B', nested: { x: 10 } })
    expect(root.api.form.value).toEqual({ name: 'B', nested: { x: 10, y: 2 } })
    root.dispose()
  })

  test('markAllTouched + reset cascade', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, '', { validators: [required()] }),
        nested: createForm(ctx, { x: createField<string>(ctx, '', { validators: [required()] }) }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.form.markAllTouched()
    expect(root.api.form.fields.name.touched.value).toBe(true)
    expect(root.api.form.fields.nested.fields.x.touched.value).toBe(true)
    expect(root.api.form.touched.value).toBe(true)

    root.api.form.fields.name.set('x')
    expect(root.api.form.isDirty.value).toBe(true)

    root.api.form.reset()
    expect(root.api.form.isDirty.value).toBe(false)
    expect(root.api.form.touched.value).toBe(false)
    root.dispose()
  })

  test('validate() awaits children and returns overall isValid', async () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, '', { validators: [required()] }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(await root.api.form.validate()).toBe(false)
    root.api.form.fields.name.set('Alice')
    expect(await root.api.form.validate()).toBe(true)
    root.dispose()
  })

  test('form options.initial does NOT start the form dirty', () => {
    // Regression: `applyPartial` previously called `Field.set(...)` for the
    // initial value, which marked dirty. Server-loaded forms were born dirty.
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        {
          name: createField<string>(ctx, ''),
          email: createField<string>(ctx, ''),
          address: createForm(ctx, {
            street: createField<string>(ctx, ''),
            city: createField<string>(ctx, ''),
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
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    // Initial values applied
    expect(root.api.form.fields.name.value).toBe('Ada')
    expect(root.api.form.fields.address.fields.city.value).toBe('London')

    // Not dirty — top level or any leaf
    expect(root.api.form.isDirty.value).toBe(false)
    expect(root.api.form.fields.name.isDirty.value).toBe(false)
    expect(root.api.form.fields.address.fields.city.isDirty.value).toBe(false)
    root.dispose()
  })

  test('reset() with initial returns to the initial values, not empty', () => {
    // Regression: reset() called Field.reset() (which goes to ctor `initial`)
    // and then re-applied form.initial via set(), making the form dirty again.
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, '') }, { initial: { name: 'Ada' } }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    root.api.form.fields.name.set('Bob')
    expect(root.api.form.fields.name.value).toBe('Bob')
    expect(root.api.form.isDirty.value).toBe(true)

    root.api.form.reset()
    expect(root.api.form.fields.name.value).toBe('Ada')
    expect(root.api.form.isDirty.value).toBe(false)
    root.dispose()
  })
})

describe('ctx.form — form-level validators', () => {
  test('topLevelErrors populated when cross-field rule fails', async () => {
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        {
          password: createField(ctx, ''),
          confirm: createField(ctx, ''),
        },
        {
          validators: [(v) => (v.password === v.confirm ? null : 'Passwords must match')],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.form.fields.password.set('abc')
    await vi.waitFor(() =>
      expect(root.api.form.topLevelErrors.value).toEqual(['Passwords must match']),
    )
    expect(root.api.form.isValid.value).toBe(false)

    root.api.form.fields.confirm.set('abc')
    await vi.waitFor(() => expect(root.api.form.topLevelErrors.value).toEqual([]))
    expect(root.api.form.isValid.value).toBe(true)
    root.dispose()
  })
})

describe('ctx.form — flatErrors', () => {
  test('emits {path,errors} entries for leaves and form-level', async () => {
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        {
          name: createField<string>(ctx, '', { validators: [required()] }),
          address: createForm(ctx, {
            city: createField<string>(ctx, '', { validators: [required()] }),
          }),
        },
        {
          validators: [(_v) => 'always wrong'],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    // Wait for the always-wrong top-level + required leaf to land in flat.
    await vi.waitFor(() => {
      const f = root.api.form.flatErrors.value
      expect(f).toContainEqual({ path: '', errors: ['always wrong'] })
      expect(f).toContainEqual({ path: 'name', errors: ['Required'] })
    })
    const flat = root.api.form.flatErrors.value
    expect(flat).toContainEqual({ path: 'address.city', errors: ['Required'] })
    root.dispose()
  })
})

describe('ctx.fieldArray', () => {
  test('add/remove/insert/move/clear', () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, (initial) => createField(ctx, initial ?? '')),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.tags.add('a')
    root.api.tags.add('b')
    root.api.tags.add('c')
    expect(root.api.tags.value).toEqual(['a', 'b', 'c'])
    expect(root.api.tags.size.value).toBe(3)

    root.api.tags.insert(1, 'x')
    expect(root.api.tags.value).toEqual(['a', 'x', 'b', 'c'])

    root.api.tags.remove(2)
    expect(root.api.tags.value).toEqual(['a', 'x', 'c'])

    root.api.tags.move(0, 2)
    expect(root.api.tags.value).toEqual(['x', 'c', 'a'])

    root.api.tags.clear()
    expect(root.api.tags.value).toEqual([])
    root.dispose()
  })

  test('arrays of sub-forms aggregate value/errors', () => {
    const def = defineController((ctx) => ({
      items: createFieldArray(ctx, (initial) =>
        createForm(
          ctx,
          {
            sku: createField<string>(ctx, '', { validators: [required()] }),
            qty: createField<number>(ctx, 1),
          },
          { initial: initial as { sku?: string; qty?: number } | undefined },
        ),
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.items.add({ sku: 'A', qty: 2 })
    root.api.items.add({ sku: '', qty: 5 })
    expect(root.api.items.value).toEqual([
      { sku: 'A', qty: 2 },
      { sku: '', qty: 5 },
    ])
    expect(root.api.items.isValid.value).toBe(false) // second item's sku is empty

    const second = root.api.items.at(1) as unknown as {
      fields: { sku: { set: (v: string) => void } }
    }
    second.fields.sku.set('B')
    expect(root.api.items.isValid.value).toBe(true)
    root.dispose()
  })

  test('array-level validators populate topLevelErrors', async () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, () => createField(ctx, ''), {
        validators: [(items) => (items.length >= 1 ? null : 'At least one')],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.tags.topLevelErrors.value).toEqual(['At least one']))
    expect(root.api.tags.isValid.value).toBe(false)

    root.api.tags.add('hello')
    await vi.waitFor(() => expect(root.api.tags.topLevelErrors.value).toEqual([]))
    expect(root.api.tags.isValid.value).toBe(true)
    root.dispose()
  })

  test('initial items + reset re-populates', () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, (initial) => createField(ctx, initial ?? ''), {
        initial: ['x', 'y'],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.tags.value).toEqual(['x', 'y'])
    root.api.tags.add('z')
    root.api.tags.reset()
    expect(root.api.tags.value).toEqual(['x', 'y'])
    root.dispose()
  })

  test('FieldArray.validate awaits async top-level + item validators', async () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(
        ctx,
        (initial) => createField<string>(ctx, initial ?? '', { validators: [required()] }),
        {
          validators: [
            async (items) => {
              await Promise.resolve()
              return items.length >= 2 ? null : 'Need ≥2'
            },
          ],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.tags.add('a')
    expect(await root.api.tags.validate()).toBe(false)
    root.api.tags.add('b')
    expect(await root.api.tags.validate()).toBe(true)
    root.dispose()
  })

  test('FieldArray.markAllTouched cascades into sub-form items', () => {
    const def = defineController((ctx) => ({
      items: createFieldArray(ctx, () =>
        createForm(ctx, { sku: createField<string>(ctx, '', { validators: [required()] }) }),
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.items.add({ sku: '' })
    root.api.items.add({ sku: '' })
    root.api.items.markAllTouched()
    const first = root.api.items.at(0) as unknown as {
      fields: { sku: { touched: { value: boolean } } }
    }
    expect(first.fields.sku.touched.value).toBe(true)
    root.dispose()
  })

  test('form.set replaces FieldArray children via applyPartial', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField(ctx, 'A'),
        tags: createFieldArray(ctx, (initial) => createField(ctx, initial ?? '')),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.form.fields.tags.add('x')
    root.api.form.fields.tags.add('y')
    root.api.form.set({ name: 'B', tags: ['p', 'q', 'r'] })
    expect(root.api.form.value).toEqual({ name: 'B', tags: ['p', 'q', 'r'] })
    root.dispose()
  })

  test('form.set preserves item identity + touched/dirty on overlapping indices', () => {
    // Repro: pre-fix `form.set({ tags: [...] })` did `clear() + add(...)` —
    // every item was a fresh field. Touched/dirty flags from the user's
    // in-progress edits on items 0/1 were wiped out by the set. With the
    // fix, overlapping indices keep their Field instance and only the
    // tail is grown/shrunk.
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        tags: createFieldArray(ctx, (initial) => createField(ctx, initial ?? '')),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.form.fields.tags.add('x')
    root.api.form.fields.tags.add('y')
    const beforeFirst = root.api.form.fields.tags.at(0)
    const beforeSecond = root.api.form.fields.tags.at(1)
    // Make item-0 touched + dirty.
    beforeFirst?.markTouched()
    beforeFirst?.set('x-edited')
    expect(beforeFirst?.touched.value).toBe(true)
    expect(beforeFirst?.isDirty.value).toBe(true)

    // Patch the array — overlap on indices 0/1, grow tail by one.
    root.api.form.set({ tags: ['x-edited', 'y-new', 'z'] })

    const afterFirst = root.api.form.fields.tags.at(0)
    const afterSecond = root.api.form.fields.tags.at(1)
    const afterThird = root.api.form.fields.tags.at(2)
    // Identity preserved on overlap; touched/dirty survive.
    expect(afterFirst).toBe(beforeFirst)
    expect(afterSecond).toBe(beforeSecond)
    expect(afterFirst?.touched.value).toBe(true)
    // Item-2 is a freshly-added field.
    expect(afterThird).toBeDefined()
    expect(afterThird).not.toBe(beforeFirst)

    // Values reflect the patch.
    expect(root.api.form.value).toEqual({ tags: ['x-edited', 'y-new', 'z'] })
    root.dispose()
  })

  test('form.resetWithInitial re-anchors initialItems so reset() returns there', () => {
    // Reaching `resetWithInitial` requires Form.options.initial as a
    // function so it can return a different shape on the second pass —
    // simulating loading server data after the form was created with a
    // placeholder. Pre-fix, the array's `initialItems` was never updated,
    // so a later `reset()` reverted to the construction-time shape `[]`
    // rather than the loaded one.
    let serverData: { tags: string[] } = { tags: ['a', 'b'] }
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        {
          tags: createFieldArray(ctx, (initial: string | undefined) =>
            createField(ctx, initial ?? ''),
          ),
        },
        { initial: () => serverData },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.value).toEqual({ tags: ['a', 'b'] })

    // "Server reloaded" — apply via resetWithInitial path. We trigger it by
    // mutating the source and calling reset() (which re-applies `initial`).
    serverData = { tags: ['x', 'y', 'z'] }
    root.api.form.reset()
    expect(root.api.form.value).toEqual({ tags: ['x', 'y', 'z'] })

    // User edits — then reset should revert to the most-recently-applied
    // initial, NOT the construction-time initial ['a','b'].
    root.api.form.fields.tags.add('w')
    expect(root.api.form.value.tags).toEqual(['x', 'y', 'z', 'w'])
    // `reset()` re-applies the form's `initial` (which now returns
    // ['x','y','z']) — so it'll go back there regardless. To exercise the
    // initialItems-anchor path we call the FieldArray's own reset:
    root.api.form.fields.tags.reset()
    expect(root.api.form.value.tags).toEqual(['x', 'y', 'z'])
    root.dispose()
  })
})

describe('async form-level + field-array-level validators', () => {
  test('Form async top-level validator transitions through isValidating', async () => {
    let resolve!: (msg: string | null) => void
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        {
          a: createField(ctx, 'x'),
        },
        {
          validators: [
            () =>
              new Promise<string | null>((r) => {
                resolve = r
              }),
          ],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    // The validator effect runs on construction; isValid is false while pending.
    await vi.waitFor(() => expect(root.api.form.isValidating.value).toBe(true))
    resolve('bad')
    await vi.waitFor(() => expect(root.api.form.topLevelErrors.value).toEqual(['bad']))
    expect(root.api.form.isValidating.value).toBe(false)
    root.dispose()
  })

  test('Form validator that throws is reported via internal onValidatorError without crashing', async () => {
    // The thrown error coerces to a string and lands in `topLevelErrors`;
    // the form keeps running (no top-level crash).
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        { a: createField(ctx, 'x') },
        {
          validators: [
            () => {
              throw new Error('boom')
            },
          ],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() =>
      expect(root.api.form.topLevelErrors.value).toEqual(expect.arrayContaining(['boom'])),
    )
    root.dispose()
  })

  test('Form.validate awaits in-flight async validator before returning', async () => {
    let resolve!: (msg: string | null) => void
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        { a: createField(ctx, 'x') },
        {
          validators: [
            () =>
              new Promise<string | null>((r) => {
                resolve = r
              }),
          ],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.form.isValidating.value).toBe(true))
    const verdict = root.api.form.validate()
    // Resolve on the next tick so validate() actually has to wait.
    setTimeout(() => resolve(null), 5)
    expect(await verdict).toBe(true)
    root.dispose()
  })

  test('FieldArray async top-level validator goes through isValidating', async () => {
    let resolve!: (msg: string | null) => void
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, () => createField(ctx, ''), {
        validators: [
          () =>
            new Promise<string | null>((r) => {
              resolve = r
            }),
        ],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.tags.isValidating.value).toBe(true))
    resolve('rejected')
    await vi.waitFor(() => expect(root.api.tags.topLevelErrors.value).toEqual(['rejected']))
    root.dispose()
  })

  test('FieldArray sync validator that throws surfaces as a string error', async () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, () => createField(ctx, ''), {
        validators: [
          () => {
            throw new Error('nope')
          },
        ],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() =>
      expect(root.api.tags.topLevelErrors.value).toEqual(expect.arrayContaining(['nope'])),
    )
    root.dispose()
  })
})

describe('flatErrors walker — fieldArray of forms', () => {
  test('emits errors at items[idx] paths for sub-forms and leaves', async () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        items: createFieldArray(ctx, (initial?: { sku?: string }) =>
          createForm(
            ctx,
            { sku: createField<string>(ctx, '', { validators: [required()] }) },
            {
              initial,
              validators: [(v) => (v.sku === 'banned' ? 'sku is banned' : null)],
            },
          ),
        ),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.form.fields.items.add({ sku: '' })
    root.api.form.fields.items.add({ sku: 'banned' })

    await vi.waitFor(() => {
      const flat = root.api.form.flatErrors.value
      expect(flat).toContainEqual({ path: 'items[0].sku', errors: ['Required'] })
      expect(flat).toContainEqual({ path: 'items[1]', errors: ['sku is banned'] })
    })
    root.dispose()
  })

  test('emits leaf errors at items[idx] when fieldArray items are plain fields', async () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, (initial?: string) =>
        createField<string>(ctx, initial ?? '', { validators: [required()] }),
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.tags.add('')
    root.api.tags.add('ok')
    await vi.waitFor(() => {
      const errs = root.api.tags.errors.value
      expect(errs[0]).toEqual(['Required'])
      expect(errs[1]).toBeUndefined()
    })
    root.dispose()
  })
})

// ---------------------------------------------------------------------------
// T5.3 — forms minor batch: validateOn, dirtyFields/clearSubtree, isValid
// stability during validation, and reset() batching.
// ---------------------------------------------------------------------------
describe('field validateOn (T5.3)', () => {
  test("'blur' defers validation until markTouched, then re-validates on change", async () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, '', { validators: [required()], validateOn: 'blur' }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    // Locked: an invalid (empty) value surfaces NO error and reads valid.
    expect(root.api.name.errors.value).toEqual([])
    expect(root.api.name.isValid.value).toBe(true)
    // A change while still locked doesn't surface errors either.
    root.api.name.set('')
    expect(root.api.name.errors.value).toEqual([])
    // Blur unlocks → validates now.
    root.api.name.markTouched()
    await vi.waitFor(() => expect(root.api.name.errors.value).toEqual(['Required']))
    // Subsequent changes re-validate live (RHF reValidateMode: onChange).
    root.api.name.set('ok')
    await vi.waitFor(() => expect(root.api.name.errors.value).toEqual([]))
    root.api.name.set('')
    await vi.waitFor(() => expect(root.api.name.errors.value).toEqual(['Required']))
    root.dispose()
  })

  test("'submit' defers until revalidate(); markTouched does NOT unlock it", async () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, '', { validators: [required()], validateOn: 'submit' }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.name.errors.value).toEqual([])
    root.api.name.markTouched()
    root.api.name.set('')
    expect(root.api.name.errors.value).toEqual([])
    // revalidate() unlocks + runs.
    await root.api.name.revalidate()
    expect(root.api.name.errors.value).toEqual(['Required'])
    root.dispose()
  })

  test('reset() re-locks a blur/submit field', async () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, '', { validators: [required()], validateOn: 'blur' }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.name.markTouched()
    await vi.waitFor(() => expect(root.api.name.errors.value).toEqual(['Required']))
    root.api.name.reset()
    expect(root.api.name.errors.value).toEqual([])
    root.api.name.set('') // still locked → no error
    expect(root.api.name.errors.value).toEqual([])
    root.dispose()
  })
})

describe('Form.dirtyFields + clearSubtree (T5.3)', () => {
  test('dirtyFields lists dotted / bracket paths of dirty leaves, depth-first', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, 'a'),
        address: createForm(ctx, { city: createField<string>(ctx, '') }),
        tags: createFieldArray(ctx, (i?: string) => createField<string>(ctx, i ?? ''), {
          initial: ['x'],
        }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.dirtyFields.value).toEqual([])
    root.api.form.fields.name.set('b')
    root.api.form.fields.address.fields.city.set('NYC')
    root.api.form.fields.tags.at(0)?.set('y')
    expect(root.api.form.dirtyFields.value).toEqual(['name', 'address.city', 'tags[0]'])
    // Setting a leaf back to its initial drops it from the list.
    root.api.form.fields.name.set('a')
    expect(root.api.form.dirtyFields.value).toEqual(['address.city', 'tags[0]'])
    root.dispose()
  })

  test('clearSubtree resets a named subtree; empty path resets the whole form', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        a: createField<string>(ctx, 'x'),
        b: createField<string>(ctx, 'y'),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.form.fields.a.set('A')
    root.api.form.fields.b.set('B')
    root.api.form.clearSubtree('a')
    expect(root.api.form.fields.a.value).toBe('x') // reset to initial
    expect(root.api.form.fields.b.value).toBe('B') // untouched
    root.api.form.fields.a.set('A2')
    root.api.form.clearSubtree('') // whole form
    expect(root.api.form.fields.a.value).toBe('x')
    expect(root.api.form.fields.b.value).toBe('y')
    root.dispose()
  })
})

describe('field isValid stays stable while validating (T5.3)', () => {
  test('async validation holds last-known validity mid-flight (no strobe)', async () => {
    let gate = deferred<string | null>()
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, 'ok', { validators: [() => gate.promise] }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    // Initial run in flight: default last-known validity is `true`, so isValid
    // reads true (not a false flash).
    expect(root.api.name.isValidating.value).toBe(true)
    expect(root.api.name.isValid.value).toBe(true)
    gate.resolve(null)
    await vi.waitFor(() => expect(root.api.name.isValidating.value).toBe(false))
    expect(root.api.name.isValid.value).toBe(true)

    // Edit → a fresh validation is in flight. isValid must HOLD the last
    // settled (valid) value, not strobe to false.
    gate = deferred<string | null>()
    root.api.name.set('ok2')
    expect(root.api.name.isValidating.value).toBe(true)
    expect(root.api.name.isValid.value).toBe(true)
    gate.resolve(null)
    await vi.waitFor(() => expect(root.api.name.isValidating.value).toBe(false))
    expect(root.api.name.isValid.value).toBe(true)
    root.dispose()
  })
})

describe('Form.reset batching (T5.3)', () => {
  test('reset() re-applies a reactive initial in one batch (no tearing)', () => {
    const seed = signal('a')
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        { name: createField<string>(ctx, '') },
        { initial: () => ({ name: seed.value }) },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.fields.name.value).toBe('a') // construction applied initial
    // Make it dirty so the reactive-initial auto-reseat is blocked while we
    // change the seed underneath it.
    root.api.form.fields.name.set('dirty')
    seed.set('b')
    expect(root.api.form.fields.name.value).toBe('dirty')

    // reset() must revert AND re-seat to the current initial ('b') in a single
    // notification — no intermediate 'a' (the pre-fix out-of-batch re-apply).
    const seen: string[] = []
    const unsub = root.api.form.fields.name.subscribeChanges((v) => seen.push(v))
    root.api.form.reset()
    unsub()
    expect(root.api.form.fields.name.value).toBe('b')
    expect(seen).toEqual(['b'])
    root.dispose()
  })
})

describe('Form and FieldArray are ReadSignals of their value, like Field', () => {
  test('value, peek, subscribe and subscribeChanges read the aggregate', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, 'a'),
        tags: createFieldArray(ctx, (t?: string) => createField<string>(ctx, t ?? ''), {
          initial: ['x'],
        }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { form } = root.api
    expect(form.value).toEqual({ name: 'a', tags: ['x'] })
    expect(form.peek()).toEqual({ name: 'a', tags: ['x'] })
    expect(form.fields.tags.value).toEqual(['x'])

    const all: unknown[] = []
    const changes: unknown[] = []
    const tagValues: unknown[] = []
    const offAll = form.subscribe((v) => all.push(v))
    const offChanges = form.subscribeChanges((v) => changes.push(v))
    const offTags = form.fields.tags.subscribeChanges((v) => tagValues.push(v))
    form.fields.name.set('b')
    form.fields.tags.add('y')
    expect(all).toEqual([
      { name: 'a', tags: ['x'] },
      { name: 'b', tags: ['x'] },
      { name: 'b', tags: ['x', 'y'] },
    ])
    expect(changes).toEqual(all.slice(1))
    expect(tagValues).toEqual([['x', 'y']])
    offAll()
    offChanges()
    offTags()
    root.dispose()
  })

  test('FieldArray.set keeps overlapping items and diffs the tail', () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, (t?: string) => createField<string>(ctx, t ?? ''), {
        initial: ['a', 'b', 'c'],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { tags } = root.api
    const first = tags.at(0)
    first?.markTouched()
    tags.set(['A', 'B'])
    expect(tags.value).toEqual(['A', 'B'])
    expect(tags.at(0)).toBe(first) // identity kept, so touched state survives
    expect(tags.at(0)?.touched.value).toBe(true)
    tags.set(['A', 'B', 'C', 'D'])
    expect(tags.value).toEqual(['A', 'B', 'C', 'D'])
    expect(tags.isDirty.value).toBe(true)
    root.dispose()
  })

  test('FieldArray.setAsInitial rebuilds a clean baseline that reset() returns to', () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, (t?: string) => createField<string>(ctx, t ?? ''), {
        initial: ['a'],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { tags } = root.api
    tags.setAsInitial(['p', 'q'])
    expect(tags.value).toEqual(['p', 'q'])
    expect(tags.isDirty.value).toBe(false)
    tags.add('r')
    tags.at(0)?.set('P')
    expect(tags.isDirty.value).toBe(true)
    tags.reset()
    expect(tags.value).toEqual(['p', 'q'])
    expect(tags.isDirty.value).toBe(false)
    root.dispose()
  })

  test('Form.setAsInitial loads a clean baseline through nested forms and arrays', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, ''),
        address: createForm(ctx, { city: createField<string>(ctx, '') }),
        tags: createFieldArray(ctx, (t?: string) => createField<string>(ctx, t ?? '')),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { form } = root.api
    form.setAsInitial({ name: 'Ada', address: { city: 'London' }, tags: ['math'] })
    expect(form.value).toEqual({ name: 'Ada', address: { city: 'London' }, tags: ['math'] })
    expect(form.isDirty.value).toBe(false)
    form.set({ address: { city: 'Paris' } })
    form.reset()
    expect(form.value).toEqual({ name: 'Ada', address: { city: 'London' }, tags: ['math'] })
    root.dispose()
  })
})

describe('form validity during async validation (spec §8.2, §8.3)', () => {
  test('a form holds its settled isValid while a field runs an async check', async () => {
    vi.useFakeTimers()
    try {
      const def = defineController((ctx) => ({
        form: createForm(ctx, {
          u: createField<string>(ctx, 'ada', {
            validators: [async () => null],
          }),
        }),
      }))
      const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
      await vi.advanceTimersByTimeAsync(0)
      const seen: boolean[] = []
      const stop = root.api.form.isValid.subscribe((v) => seen.push(v))
      root.api.form.fields.u.set('ada2')
      expect(root.api.form.fields.u.isValidating.value).toBe(true)
      expect(root.api.form.isValid.value).toBe(true) // no flicker to false
      await vi.advanceTimersByTimeAsync(0)
      expect(seen.every((v) => v)).toBe(true)
      stop()
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an invalid form stays invalid while its own async validator re-runs', async () => {
    let release: (v: string | null) => void = () => {}
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        { a: createField<string>(ctx, 'x') },
        {
          validators: [
            () =>
              new Promise<string | null>((resolve) => {
                release = resolve
              }),
          ],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    release('taken')
    await Promise.resolve()
    await Promise.resolve()
    expect(root.api.form.isValid.value).toBe(false)
    root.api.form.fields.a.set('y') // re-runs the form validator
    expect(root.api.form.isValidating.value).toBe(true)
    expect(root.api.form.isValid.value).toBe(false) // holds, no flicker to true
    release(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(root.api.form.isValid.value).toBe(true)
    root.dispose()
  })

  test('a rejected async form-level or array-level validator is an error, as on a field', async () => {
    const down = () => Promise.reject(new Error('down'))
    const def = defineController((ctx) => ({
      form: createForm(ctx, { a: createField<string>(ctx, 'x') }, { validators: [down] }),
      tags: createFieldArray(ctx, (t?: string) => createField<string>(ctx, t ?? ''), {
        initial: ['a'],
        validators: [down],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.form.topLevelErrors.value).toEqual(['down']))
    expect(root.api.form.isValid.value).toBe(false)
    expect(root.api.tags.topLevelErrors.value).toEqual(['down'])
    expect(root.api.tags.isValid.value).toBe(false)
    root.dispose()
  })
})

describe('FieldArray — a no-op edit leaves the array clean', () => {
  test('remove / move out of range, or move to the same index, do not mark it dirty', () => {
    const def = defineController((ctx) => ({
      tags: createFieldArray(ctx, (t?: string) => createField<string>(ctx, t ?? ''), {
        initial: ['a', 'b'],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.tags.remove(5)
    root.api.tags.remove(-1)
    root.api.tags.move(9, 0)
    root.api.tags.move(1, 1)
    expect(root.api.tags.value).toEqual(['a', 'b'])
    expect(root.api.tags.isDirty.value).toBe(false)
    root.api.tags.move(0, 1)
    expect(root.api.tags.value).toEqual(['b', 'a'])
    expect(root.api.tags.isDirty.value).toBe(true)
    root.dispose()
  })
})

// A form-level validator owns the errors it routes. A reset or `setAsInitial`
// that leaves the form's value unchanged does not re-run it, so clearing the
// routed errors there hid a rule that still failed: `form.isValid` read true
// until the next edit (1.0 coverage pass).
describe('regression: a no-op reset keeps form-level errors visible', () => {
  const mismatch = (v: { password: string; confirm: string }) =>
    v.password === v.confirm ? [] : [{ path: ['confirm'], message: 'Passwords must match' }]

  const build = () => {
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        {
          password: createField<string>(ctx, ''),
          confirm: createField<string>(ctx, ''),
        },
        { validators: [mismatch] },
      ),
    }))
    return createRoot(def, { queries: queryEngine(), deps: emptyDeps })
  }

  test('field.reset() on an unchanged field keeps the routed error and the form invalid', () => {
    const root = build()
    const { form } = root.api
    form.fields.password.set('secret')
    expect(form.fields.confirm.errors.value).toEqual(['Passwords must match'])
    // `confirm` is already at its initial '', so the form's value does not move.
    form.fields.confirm.reset()
    expect(form.fields.confirm.errors.value).toEqual(['Passwords must match'])
    expect(form.isValid.value).toBe(false)
    root.dispose()
  })

  test('field.setAsInitial() with the same value keeps the routed error', () => {
    const root = build()
    const { form } = root.api
    form.fields.password.set('secret')
    form.fields.confirm.setAsInitial('')
    expect(form.fields.confirm.errors.value).toEqual(['Passwords must match'])
    expect(form.isValid.value).toBe(false)
    root.dispose()
  })

  test('a reset that changes the value re-runs the form, which recomputes the error', () => {
    const root = build()
    const { form } = root.api
    form.fields.password.set('secret')
    form.fields.confirm.set('secret')
    expect(form.isValid.value).toBe(true)
    // Back to '' while password is 'secret': the rule fails again.
    form.fields.confirm.reset()
    expect(form.fields.confirm.errors.value).toEqual(['Passwords must match'])
    // Resetting password too satisfies the rule, and the error clears.
    form.fields.password.reset()
    expect(form.fields.confirm.errors.value).toEqual([])
    expect(form.isValid.value).toBe(true)
    root.dispose()
  })

  test("form.reset() on an unchanged form keeps its own validator's errors", () => {
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        {
          start: createField<number>(ctx, 5),
          end: createField<number>(ctx, 1),
        },
        { validators: [(v) => (v.end > v.start ? null : 'End must be after start')] },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { form } = root.api
    expect(form.topLevelErrors.value).toEqual(['End must be after start'])
    form.reset()
    expect(form.topLevelErrors.value).toEqual(['End must be after start'])
    expect(form.isValid.value).toBe(false)
    root.dispose()
  })

  test('an error an outer form routed onto a nested form survives the nested reset()', () => {
    const def = defineController((ctx) => {
      const address = createForm(ctx, { city: createField<string>(ctx, '') })
      return {
        form: createForm(
          ctx,
          { country: createField<string>(ctx, 'NL'), address },
          {
            validators: [
              (v) =>
                v.country === 'NL' && v.address.city === ''
                  ? [{ path: ['address'], message: 'Pick a city' }]
                  : [],
            ],
          },
        ),
      }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { form } = root.api
    expect(form.fields.address.topLevelErrors.value).toEqual(['Pick a city'])
    form.fields.address.reset()
    expect(form.fields.address.topLevelErrors.value).toEqual(['Pick a city'])
    expect(form.isValid.value).toBe(false)
    root.dispose()
  })

  test('a no-op reset during an async form-level run neither restarts it nor loses its result', async () => {
    const pending = deferred<FormIssue[]>()
    let runs = 0
    const def = defineController((ctx) => ({
      form: createForm(
        ctx,
        { name: createField<string>(ctx, '') },
        {
          validators: [
            () => {
              runs += 1
              return pending.promise
            },
          ],
        },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const { form } = root.api
    expect(runs).toBe(1)
    expect(form.isValidating.value).toBe(true)
    form.fields.name.reset()
    expect(runs).toBe(1)
    pending.resolve([{ path: ['name'], message: 'Taken' }])
    await vi.waitFor(() => expect(form.isValidating.value).toBe(false))
    expect(form.fields.name.errors.value).toEqual(['Taken'])
    form.fields.name.reset()
    expect(form.fields.name.errors.value).toEqual(['Taken'])
    expect(runs).toBe(1)
    root.dispose()
  })
})
