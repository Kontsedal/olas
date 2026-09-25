import { describe, expect, test, vi } from 'vitest'
import {
  type Ctx,
  createField,
  createFieldArray,
  createForm,
  createRoot,
  defineController,
  type FormIssue,
  signal,
} from '../src'

function build<Api>(factory: (ctx: Ctx) => Api) {
  return createRoot(defineController(factory), { deps: {} })
}

const tagsOf = (ctx: Ctx, initial: string[] = []) =>
  createFieldArray(ctx, (value?: string) => createField<string>(ctx, value ?? ''), { initial })

describe('form-level FormIssue routing', () => {
  /** A form whose single validator returns whatever `issues` currently holds. */
  function routed(initialIssues: FormIssue[] = []) {
    const issues = signal<FormIssue[]>(initialIssues)
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        {
          name: createField<string>(ctx, 'Ada'),
          tags: tagsOf(ctx, ['x', 'y']),
        },
        { validators: [() => issues.value] },
      ),
    }))
    return { root, form: root.api.form, issues }
  }

  test('paths that run off the tree fall back to topLevelErrors', () => {
    const { root, form, issues } = routed()
    issues.set([
      { path: ['missing', 'deeper'], message: 'through a missing key' },
      { path: ['name', 'deeper'], message: 'past a leaf' },
      { path: ['tags', -1], message: 'negative index' },
      { path: ['tags', 'first'], message: 'non-numeric index' },
    ])
    expect(form.topLevelErrors.value).toEqual([
      'through a missing key',
      'past a leaf',
      'negative index',
      'non-numeric index',
    ])
    expect(form.fields.name.errors.value).toEqual([])
    expect(form.fields.tags.topLevelErrors.value).toEqual([])
    root.dispose()
  })

  test('several issues on one field all land on it, and a repeat target keeps its errors', () => {
    const { root, form, issues } = routed()
    issues.set([
      { path: ['name'], message: 'too short' },
      { path: ['name'], message: 'no digits' },
    ])
    expect(form.fields.name.errors.value).toEqual(['too short', 'no digits'])
    // The next run targets the same field again: its errors are replaced, not cleared.
    issues.set([{ path: ['name'], message: 'still wrong' }])
    expect(form.fields.name.errors.value).toEqual(['still wrong'])
    expect(form.isValid.value).toBe(false)
    root.dispose()
  })

  test('a path naming a field array lands on the array, and an index lands on its item', () => {
    const { root, form, issues } = routed()
    const tags = form.fields.tags
    issues.set([
      { path: ['tags'], message: 'too many tags' },
      { path: ['tags', 1], message: 'duplicate tag' },
    ])
    expect(tags.topLevelErrors.value).toEqual(['too many tags'])
    expect(tags.at(1)?.errors.value).toEqual(['duplicate tag'])
    expect(tags.isValid.value).toBe(false)
    expect(form.flatErrors.value).toEqual([
      { path: 'tags', errors: ['too many tags'] },
      { path: 'tags[1]', errors: ['duplicate tag'] },
    ])
    // Fixing the rule clears both targets.
    issues.set([])
    expect(tags.topLevelErrors.value).toEqual([])
    expect(tags.at(1)?.errors.value).toEqual([])
    expect(form.flatErrors.value).toEqual([])
    root.dispose()
  })

  test('a disposed field array ignores errors routed to it', () => {
    const { root, form, issues } = routed()
    form.fields.tags.dispose()
    issues.set([{ path: ['tags'], message: 'too many tags' }])
    expect(form.fields.tags.topLevelErrors.value).toEqual([])
    root.dispose()
  })

  test('a nested form merges its own top-level errors with routed ones', () => {
    const country = signal('UA')
    const root = build((ctx) => {
      const address = createForm(
        ctx,
        { street: createField<string>(ctx, '') },
        { validators: [(v) => (v.street === '' ? 'street required' : null)] },
      )
      const form = createForm(
        ctx,
        { address },
        {
          validators: [
            () =>
              country.value === 'XX' ? [{ path: ['address'], message: 'unsupported country' }] : [],
          ],
        },
      )
      return { form }
    })
    const { form } = root.api
    const address = form.fields.address
    expect(address.topLevelErrors.value).toEqual(['street required'])

    country.set('XX')
    expect(address.topLevelErrors.value).toEqual(['street required', 'unsupported country'])

    address.fields.street.set('Main')
    expect(address.topLevelErrors.value).toEqual(['unsupported country'])
    expect(form.flatErrors.value).toEqual([{ path: 'address', errors: ['unsupported country'] }])
    expect(form.isValid.value).toBe(false)

    country.set('UA')
    expect(address.topLevelErrors.value).toEqual([])
    expect(form.isValid.value).toBe(true)
    root.dispose()
  })

  test('resetting a nested form or array that carried a routed error leaves it clean', () => {
    const root = build((ctx) => {
      const address = createForm(ctx, { city: createField<string>(ctx, '') })
      const tags = tagsOf(ctx, ['a', 'b'])
      return {
        form: createForm(
          ctx,
          { address, tags },
          {
            validators: [
              (v) => [
                ...(v.address.city === 'bad' ? [{ path: ['address'], message: 'bad city' }] : []),
                ...(v.tags.length > 2 ? [{ path: ['tags'], message: 'too many tags' }] : []),
              ],
            ],
          },
        ),
      }
    })
    const { form } = root.api
    const { address, tags } = form.fields
    address.fields.city.set('bad')
    tags.add('c')
    expect(address.topLevelErrors.value).toEqual(['bad city'])
    expect(tags.topLevelErrors.value).toEqual(['too many tags'])

    // Each reset clears the routed error and restores a value the rule accepts;
    // the form's next run then has nothing left to clear on either node.
    address.reset()
    tags.reset()
    expect(address.topLevelErrors.value).toEqual([])
    expect(tags.topLevelErrors.value).toEqual([])
    expect(form.isValid.value).toBe(true)
    root.dispose()
  })

  test('a disposed nested form ignores errors routed to it', () => {
    const route = signal(false)
    const root = build((ctx) => {
      const address = createForm(ctx, { street: createField<string>(ctx, 'Main') })
      return {
        form: createForm(
          ctx,
          { address },
          { validators: [() => (route.value ? [{ path: ['address'], message: 'bad' }] : [])] },
        ),
      }
    })
    const address = root.api.form.fields.address
    address.dispose()
    route.set(true)
    expect(address.topLevelErrors.value).toEqual([])
    root.dispose()
  })
})

describe('form-level validator edge cases', () => {
  test('a validator throwing a non-Error surfaces its string form at the top level', () => {
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { a: createField<string>(ctx, 'x') },
        {
          validators: [
            () => {
              throw 'form rule exploded'
            },
          ],
        },
      ),
    }))
    expect(root.api.form.topLevelErrors.value).toEqual(['form rule exploded'])
    expect(root.api.form.isValid.value).toBe(false)
    root.dispose()
  })

  test('a superseded async run is dropped; the latest run wins', async () => {
    const pending: Array<(r: string | null) => void> = []
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { a: createField<string>(ctx, 'first') },
        {
          validators: [
            () =>
              new Promise<string | null>((resolve) => {
                pending.push(resolve)
              }),
          ],
        },
      ),
    }))
    const form = root.api.form
    form.fields.a.set('second')
    expect(pending).toHaveLength(2)
    pending[0]?.('stale result')
    await Promise.resolve()
    await Promise.resolve()
    expect(form.topLevelErrors.value).toEqual([])
    expect(form.isValidating.value).toBe(true)
    pending[1]?.('fresh result')
    await vi.waitFor(() => expect(form.topLevelErrors.value).toEqual(['fresh result']))
    expect(form.isValidating.value).toBe(false)
    root.dispose()
  })

  test('an async run that settles after dispose writes nothing', async () => {
    let resolve!: (r: string | null) => void
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { a: createField<string>(ctx, 'x') },
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
    const form = root.api.form
    root.dispose()
    resolve('too late')
    await Promise.resolve()
    await Promise.resolve()
    expect(form.topLevelErrors.value).toEqual([])
  })

  test('validate() whose form is disposed mid-flight does not re-run the form validators', async () => {
    const formRule = vi.fn(() => null)
    const root = build((ctx) => ({
      form: createForm(ctx, { a: createField<string>(ctx, 'x') }, { validators: [formRule] }),
    }))
    const form = root.api.form
    expect(formRule).toHaveBeenCalledTimes(1)
    const pending = form.validate()
    form.dispose()
    await expect(pending).resolves.toBe(true)
    expect(formRule).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('isValidating is true while a leaf validates, false once it settles', async () => {
    let resolve!: (r: string | null) => void
    const root = build((ctx) => ({
      form: createForm(ctx, {
        a: createField<string>(ctx, 'x', {
          validators: [
            () =>
              new Promise<string | null>((r) => {
                resolve = r
              }),
          ],
        }),
      }),
    }))
    const form = root.api.form
    expect(form.isValidating.value).toBe(true)
    resolve(null)
    await vi.waitFor(() => expect(form.isValidating.value).toBe(false))
    expect(form.isValid.value).toBe(true)
    root.dispose()
  })
})

describe('form aggregates over nested forms and field arrays', () => {
  function nested() {
    return build((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, '', { validators: [(v) => (v ? null : 'name required')] }),
        address: createForm(ctx, {
          city: createField<string>(ctx, '', {
            validators: [(v) => (v ? null : 'city required')],
          }),
        }),
        tags: createFieldArray(
          ctx,
          (value?: string) =>
            createField<string>(ctx, value ?? '', {
              validators: [(v) => (v ? null : 'tag required')],
            }),
          { initial: ['ok', ''] },
        ),
      }),
    }))
  }

  test('errors mirrors the schema through nested forms and arrays', () => {
    const root = nested()
    expect(root.api.form.errors.value).toEqual({
      name: ['name required'],
      address: { city: ['city required'] },
      tags: [undefined, ['tag required']],
    })
    root.dispose()
  })

  test('markAllTouched reaches array items; validate() reaches nested nodes', async () => {
    const root = nested()
    const form = root.api.form
    form.markAllTouched()
    expect(form.fields.tags.at(0)?.touched.value).toBe(true)
    expect(form.fields.tags.at(1)?.touched.value).toBe(true)
    expect(form.fields.address.fields.city.touched.value).toBe(true)
    await expect(form.validate()).resolves.toBe(false)
    form.set({ name: 'Ada', address: { city: 'Kyiv' }, tags: ['ok', 'fine'] })
    await expect(form.validate()).resolves.toBe(true)
    root.dispose()
  })

  test('set() ignores keys the schema does not have', () => {
    const root = nested()
    const form = root.api.form
    form.set({ name: 'Ada', nope: 'ignored' } as never)
    expect(form.value).toEqual({ name: 'Ada', address: { city: '' }, tags: ['ok', ''] })
    root.dispose()
  })

  test('dirtyFields walks into forms held by a field array', () => {
    const root = build((ctx) => ({
      form: createForm(ctx, {
        lines: createFieldArray(
          ctx,
          (initial?: { sku?: string; qty?: number }) =>
            createForm(ctx, {
              sku: createField<string>(ctx, initial?.sku ?? ''),
              qty: createField<number>(ctx, initial?.qty ?? 1),
            }),
          { initial: [{ sku: 'A', qty: 1 }] },
        ),
      }),
    }))
    const line = root.api.form.fields.lines.at(0)
    line?.fields.qty.set(5)
    expect(root.api.form.dirtyFields.value).toEqual(['lines[0].qty'])
    root.dispose()
  })
})

describe('reactive initial', () => {
  test('an initial() that returns undefined leaves the form alone until data arrives', () => {
    const data = signal<{ name: string } | undefined>(undefined)
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { name: createField<string>(ctx, 'seed') },
        { initial: () => data.value, resetOnInitialChange: 'never' },
      ),
    }))
    const form = root.api.form
    expect(form.value).toEqual({ name: 'seed' })

    // The first defined value seats the form, even under 'never'.
    data.set({ name: 'Ada' })
    expect(form.value).toEqual({ name: 'Ada' })
    expect(form.isDirty.value).toBe(false)

    // Later changes do not, under 'never'.
    data.set({ name: 'Grace' })
    expect(form.value).toEqual({ name: 'Ada' })
    root.dispose()
  })

  test('reset() with an initial() that currently returns undefined restores each leaf', () => {
    const data = signal<{ name: string } | undefined>({ name: 'Ada' })
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { name: createField<string>(ctx, 'seed') },
        { initial: () => data.value },
      ),
    }))
    const form = root.api.form
    form.fields.name.set('typed')
    data.set(undefined)
    form.reset()
    // The leaf returns to the last baseline it was seated with.
    expect(form.value).toEqual({ name: 'Ada' })
    expect(form.isDirty.value).toBe(false)
    root.dispose()
  })
})

describe('Form.setErrors and clearSubtree paths', () => {
  function withTags() {
    return build((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, 'Ada'),
        tags: tagsOf(ctx, ['a', 'b']),
      }),
    }))
  }

  test('bracket and dot index paths reach the same array item', () => {
    const root = withTags()
    const form = root.api.form
    form.setErrors({ 'tags[0]': ['bracket'] })
    expect(form.fields.tags.at(0)?.errors.value).toEqual(['bracket'])
    form.setErrors({ 'tags.1': ['dot'] })
    expect(form.fields.tags.at(1)?.errors.value).toEqual(['dot'])
    root.dispose()
  })

  test('paths that resolve to no node are ignored; the form and the array take their own', () => {
    const root = withTags()
    const form = root.api.form
    form.setErrors({
      '': ['empty path'],
      'missing.deeper': ['missing key'],
      'name.deeper': ['past a leaf'],
      'tags.first': ['non-numeric index'],
      'tags.-1': ['negative index'],
      'tags[0][0]': ['index past a leaf'],
      'tags[0].deeper': ['key past an item leaf'],
      tags: ['the array itself'],
      'tags[': ['unclosed bracket'],
      'tags[]': ['empty bracket'],
      'tags[x]': ['non-numeric bracket'],
      'tags]': ['stray bracket'],
    })
    // `''` names the form and `tags` names the array: each lands on that
    // node's `topLevelErrors`. Every other path resolves to nothing.
    expect(form.flatErrors.value).toEqual([
      { path: '', errors: ['empty path'] },
      { path: 'tags', errors: ['the array itself'] },
    ])
    expect(form.isValid.value).toBe(false)
    root.dispose()
  })

  test('clearSubtree resets one item and ignores unknown paths', () => {
    const root = withTags()
    const form = root.api.form
    form.fields.tags.at(0)?.set('changed')
    form.fields.name.set('Grace')
    form.clearSubtree('missing')
    form.clearSubtree('tags[0]')
    expect(form.value).toEqual({ name: 'Grace', tags: ['a', 'b'] })
    root.dispose()
  })
})

describe('Form after dispose()', () => {
  test('every mutating method is a no-op', async () => {
    const root = build((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, 'Ada'),
        tags: tagsOf(ctx, ['a']),
      }),
    }))
    const form = root.api.form
    form.fields.name.set('Grace')
    form.dispose()
    form.dispose()

    form.set({ name: 'Linus' })
    form.setAsInitial({ name: 'Linus' })
    form.reset()
    form.markAllTouched()
    form.setErrors({ name: ['server'] })
    form.clearSubtree('name')

    expect(form.value).toEqual({ name: 'Grace', tags: ['a'] })
    expect(form.touched.value).toBe(false)
    expect(form.fields.name.errors.value).toEqual([])
    await expect(form.validate()).resolves.toBe(true)
    await expect(form.submit(() => 'data')).resolves.toEqual({ ok: false, reason: 'disposed' })
    root.dispose()
  })
})
