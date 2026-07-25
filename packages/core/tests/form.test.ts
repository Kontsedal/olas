import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { required } from '../src/forms/validators'
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

  test('FieldArray.validate awaits async top-level + item validators', async () => {
    const def = defineController((ctx) => ({
      tags: ctx.fieldArray((initial) => ctx.field<string>(initial ?? '', [required()]), {
        validators: [
          async (items) => {
            await Promise.resolve()
            return items.length >= 2 ? null : 'Need ≥2'
          },
        ],
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.tags.add('a')
    expect(await root.tags.validate()).toBe(false)
    root.tags.add('b')
    expect(await root.tags.validate()).toBe(true)
    root.dispose()
  })

  test('FieldArray.markAllTouched cascades into sub-form items', () => {
    const def = defineController((ctx) => ({
      items: ctx.fieldArray(() => ctx.form({ sku: ctx.field<string>('', [required()]) })),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.items.add({ sku: '' })
    root.items.add({ sku: '' })
    root.items.markAllTouched()
    const first = root.items.at(0) as unknown as {
      fields: { sku: { touched: { value: boolean } } }
    }
    expect(first.fields.sku.touched.value).toBe(true)
    root.dispose()
  })

  test('form.set replaces FieldArray children via applyPartial', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field('A'),
        tags: ctx.fieldArray((initial) => ctx.field(initial ?? '')),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.fields.tags.add('x')
    root.form.fields.tags.add('y')
    root.form.set({ name: 'B', tags: ['p', 'q', 'r'] })
    expect(root.form.value.value).toEqual({ name: 'B', tags: ['p', 'q', 'r'] })
    root.dispose()
  })

  test('form.set preserves item identity + touched/dirty on overlapping indices', () => {
    // Repro: pre-fix `form.set({ tags: [...] })` did `clear() + add(...)` —
    // every item was a fresh field. Touched/dirty flags from the user's
    // in-progress edits on items 0/1 were wiped out by the set. With the
    // fix, overlapping indices keep their Field instance and only the
    // tail is grown/shrunk.
    const def = defineController((ctx) => ({
      form: ctx.form({
        tags: ctx.fieldArray((initial) => ctx.field(initial ?? '')),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.fields.tags.add('x')
    root.form.fields.tags.add('y')
    const beforeFirst = root.form.fields.tags.at(0)
    const beforeSecond = root.form.fields.tags.at(1)
    // Make item-0 touched + dirty.
    beforeFirst?.markTouched()
    beforeFirst?.set('x-edited')
    expect(beforeFirst?.touched.value).toBe(true)
    expect(beforeFirst?.isDirty.value).toBe(true)

    // Patch the array — overlap on indices 0/1, grow tail by one.
    root.form.set({ tags: ['x-edited', 'y-new', 'z'] })

    const afterFirst = root.form.fields.tags.at(0)
    const afterSecond = root.form.fields.tags.at(1)
    const afterThird = root.form.fields.tags.at(2)
    // Identity preserved on overlap; touched/dirty survive.
    expect(afterFirst).toBe(beforeFirst)
    expect(afterSecond).toBe(beforeSecond)
    expect(afterFirst?.touched.value).toBe(true)
    // Item-2 is a freshly-added field.
    expect(afterThird).toBeDefined()
    expect(afterThird).not.toBe(beforeFirst)

    // Values reflect the patch.
    expect(root.form.value.value).toEqual({ tags: ['x-edited', 'y-new', 'z'] })
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
      form: ctx.form(
        {
          tags: ctx.fieldArray((initial: string | undefined) => ctx.field(initial ?? '')),
        },
        { initial: () => serverData },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.value.value).toEqual({ tags: ['a', 'b'] })

    // "Server reloaded" — apply via resetWithInitial path. We trigger it by
    // mutating the source and calling reset() (which re-applies `initial`).
    serverData = { tags: ['x', 'y', 'z'] }
    root.form.reset()
    expect(root.form.value.value).toEqual({ tags: ['x', 'y', 'z'] })

    // User edits — then reset should revert to the most-recently-applied
    // initial, NOT the construction-time initial ['a','b'].
    root.form.fields.tags.add('w')
    expect(root.form.value.value.tags).toEqual(['x', 'y', 'z', 'w'])
    // `reset()` re-applies the form's `initial` (which now returns
    // ['x','y','z']) — so it'll go back there regardless. To exercise the
    // initialItems-anchor path we call the FieldArray's own reset:
    root.form.fields.tags.reset()
    expect(root.form.value.value.tags).toEqual(['x', 'y', 'z'])
    root.dispose()
  })
})

describe('async form-level + field-array-level validators', () => {
  test('Form async top-level validator transitions through isValidating', async () => {
    let resolve!: (msg: string | null) => void
    const def = defineController((ctx) => ({
      form: ctx.form(
        {
          a: ctx.field('x'),
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
    const root = createRoot(def, { deps: emptyDeps })
    // The validator effect runs on construction; isValid is false while pending.
    await vi.waitFor(() => expect(root.form.isValidating.value).toBe(true))
    resolve('bad')
    await vi.waitFor(() => expect(root.form.topLevelErrors.value).toEqual(['bad']))
    expect(root.form.isValidating.value).toBe(false)
    root.dispose()
  })

  test('Form validator that throws is reported via internal onValidatorError without crashing', async () => {
    // The thrown error coerces to a string and lands in `topLevelErrors`;
    // the form keeps running (no top-level crash).
    const def = defineController((ctx) => ({
      form: ctx.form(
        { a: ctx.field('x') },
        {
          validators: [
            () => {
              throw new Error('boom')
            },
          ],
        },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() =>
      expect(root.form.topLevelErrors.value).toEqual(expect.arrayContaining(['boom'])),
    )
    root.dispose()
  })

  test('Form.validate awaits in-flight async validator before returning', async () => {
    let resolve!: (msg: string | null) => void
    const def = defineController((ctx) => ({
      form: ctx.form(
        { a: ctx.field('x') },
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
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.form.isValidating.value).toBe(true))
    const verdict = root.form.validate()
    // Resolve on the next tick so validate() actually has to wait.
    setTimeout(() => resolve(null), 5)
    expect(await verdict).toBe(true)
    root.dispose()
  })

  test('FieldArray async top-level validator goes through isValidating', async () => {
    let resolve!: (msg: string | null) => void
    const def = defineController((ctx) => ({
      tags: ctx.fieldArray(() => ctx.field(''), {
        validators: [
          () =>
            new Promise<string | null>((r) => {
              resolve = r
            }),
        ],
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() => expect(root.tags.isValidating.value).toBe(true))
    resolve('rejected')
    await vi.waitFor(() => expect(root.tags.topLevelErrors.value).toEqual(['rejected']))
    root.dispose()
  })

  test('FieldArray sync validator that throws surfaces as a string error', async () => {
    const def = defineController((ctx) => ({
      tags: ctx.fieldArray(() => ctx.field(''), {
        validators: [
          () => {
            throw new Error('nope')
          },
        ],
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.waitFor(() =>
      expect(root.tags.topLevelErrors.value).toEqual(expect.arrayContaining(['nope'])),
    )
    root.dispose()
  })
})

describe('flatErrors walker — fieldArray of forms', () => {
  test('emits errors at items[idx] paths for sub-forms and leaves', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        items: ctx.fieldArray((initial?: { sku?: string }) =>
          ctx.form(
            { sku: ctx.field<string>('', [required()]) },
            {
              initial,
              validators: [(v) => (v.sku === 'banned' ? 'sku is banned' : null)],
            },
          ),
        ),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.fields.items.add({ sku: '' })
    root.form.fields.items.add({ sku: 'banned' })

    await vi.waitFor(() => {
      const flat = root.form.flatErrors.value
      expect(flat).toContainEqual({ path: 'items[0].sku', errors: ['Required'] })
      expect(flat).toContainEqual({ path: 'items[1]', errors: ['sku is banned'] })
    })
    root.dispose()
  })

  test('emits leaf errors at items[idx] when fieldArray items are plain fields', async () => {
    const def = defineController((ctx) => ({
      tags: ctx.fieldArray((initial?: string) => ctx.field<string>(initial ?? '', [required()])),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.tags.add('')
    root.tags.add('ok')
    await vi.waitFor(() => {
      const errs = root.tags.errors.value
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
      name: ctx.field<string>('', [required()], { validateOn: 'blur' }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    // Locked: an invalid (empty) value surfaces NO error and reads valid.
    expect(root.name.errors.value).toEqual([])
    expect(root.name.isValid.value).toBe(true)
    // A change while still locked doesn't surface errors either.
    root.name.set('')
    expect(root.name.errors.value).toEqual([])
    // Blur unlocks → validates now.
    root.name.markTouched()
    await vi.waitFor(() => expect(root.name.errors.value).toEqual(['Required']))
    // Subsequent changes re-validate live (RHF reValidateMode: onChange).
    root.name.set('ok')
    await vi.waitFor(() => expect(root.name.errors.value).toEqual([]))
    root.name.set('')
    await vi.waitFor(() => expect(root.name.errors.value).toEqual(['Required']))
    root.dispose()
  })

  test("'submit' defers until revalidate(); markTouched does NOT unlock it", async () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>('', [required()], { validateOn: 'submit' }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.name.errors.value).toEqual([])
    root.name.markTouched()
    root.name.set('')
    expect(root.name.errors.value).toEqual([])
    // revalidate() unlocks + runs.
    await root.name.revalidate()
    expect(root.name.errors.value).toEqual(['Required'])
    root.dispose()
  })

  test('reset() re-locks a blur/submit field', async () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>('', [required()], { validateOn: 'blur' }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.name.markTouched()
    await vi.waitFor(() => expect(root.name.errors.value).toEqual(['Required']))
    root.name.reset()
    expect(root.name.errors.value).toEqual([])
    root.name.set('') // still locked → no error
    expect(root.name.errors.value).toEqual([])
    root.dispose()
  })
})

describe('Form.dirtyFields + clearSubtree (T5.3)', () => {
  test('dirtyFields lists dotted / bracket paths of dirty leaves, depth-first', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('a'),
        address: ctx.form({ city: ctx.field<string>('') }),
        tags: ctx.fieldArray((i?: string) => ctx.field<string>(i ?? ''), { initial: ['x'] }),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.dirtyFields.value).toEqual([])
    root.form.fields.name.set('b')
    root.form.fields.address.fields.city.set('NYC')
    root.form.fields.tags.at(0)?.set('y')
    expect(root.form.dirtyFields.value).toEqual(['name', 'address.city', 'tags[0]'])
    // Setting a leaf back to its initial drops it from the list.
    root.form.fields.name.set('a')
    expect(root.form.dirtyFields.value).toEqual(['address.city', 'tags[0]'])
    root.dispose()
  })

  test('clearSubtree resets a named subtree; empty path resets the whole form', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        a: ctx.field<string>('x'),
        b: ctx.field<string>('y'),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.form.fields.a.set('A')
    root.form.fields.b.set('B')
    root.form.clearSubtree('a')
    expect(root.form.fields.a.value).toBe('x') // reset to initial
    expect(root.form.fields.b.value).toBe('B') // untouched
    root.form.fields.a.set('A2')
    root.form.clearSubtree('') // whole form
    expect(root.form.fields.a.value).toBe('x')
    expect(root.form.fields.b.value).toBe('y')
    root.dispose()
  })
})

describe('field isValid stays stable while validating (T5.3)', () => {
  test('async validation holds last-known validity mid-flight (no strobe)', async () => {
    let gate = deferred<string | null>()
    const def = defineController((ctx) => ({
      name: ctx.field<string>('ok', [() => gate.promise]),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    // Initial run in flight: default last-known validity is `true`, so isValid
    // reads true (not a false flash).
    expect(root.name.isValidating.value).toBe(true)
    expect(root.name.isValid.value).toBe(true)
    gate.resolve(null)
    await vi.waitFor(() => expect(root.name.isValidating.value).toBe(false))
    expect(root.name.isValid.value).toBe(true)

    // Edit → a fresh validation is in flight. isValid must HOLD the last
    // settled (valid) value, not strobe to false.
    gate = deferred<string | null>()
    root.name.set('ok2')
    expect(root.name.isValidating.value).toBe(true)
    expect(root.name.isValid.value).toBe(true)
    gate.resolve(null)
    await vi.waitFor(() => expect(root.name.isValidating.value).toBe(false))
    expect(root.name.isValid.value).toBe(true)
    root.dispose()
  })
})

describe('Form.reset batching (T5.3)', () => {
  test('reset() re-applies a reactive initial in one batch (no tearing)', () => {
    const seed = signal('a')
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('') }, { initial: () => ({ name: seed.value }) }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.form.fields.name.value).toBe('a') // construction applied initial
    // Make it dirty so the reactive-initial auto-reseat is blocked while we
    // change the seed underneath it.
    root.form.fields.name.set('dirty')
    seed.set('b')
    expect(root.form.fields.name.value).toBe('dirty')

    // reset() must revert AND re-seat to the current initial ('b') in a single
    // notification — no intermediate 'a' (the pre-fix out-of-batch re-apply).
    const seen: string[] = []
    const unsub = root.form.fields.name.subscribeChanges((v) => seen.push(v))
    root.form.reset()
    unsub()
    expect(root.form.fields.name.value).toBe('b')
    expect(seen).toEqual(['b'])
    root.dispose()
  })
})
