import { describe, expect, test, vi } from 'vitest'
import {
  type Ctx,
  createField,
  createFieldArray,
  createForm,
  createRoot,
  defineController,
  type ErrorContext,
  type Field,
  type FormIssue,
  required,
  signal,
} from '../src'

/** Build an engine-less root around `factory` and return its handle. */
function build<Api>(
  factory: (ctx: Ctx) => Api,
  onError?: (err: unknown, context: ErrorContext) => void,
) {
  return createRoot(defineController(factory), { deps: {}, onError })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 'settled' when `p` settles within a macrotask, 'pending' when it does not. */
async function settlesSoon(p: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    tick().then(() => 'pending' as const),
  ])
}

/**
 * An async validator whose calls the test settles by value. It ignores its
 * AbortSignal, the way a careless validator does.
 */
function manualAsync() {
  const pending = new Map<string, Array<(r: string | null) => void>>()
  const calls: string[] = []
  const validator = (v: string): Promise<string | null> => {
    calls.push(v)
    return new Promise<string | null>((resolve) => {
      const list = pending.get(v) ?? []
      list.push(resolve)
      pending.set(v, list)
    })
  }
  const settle = (v: string, result: string | null): void => {
    for (const resolve of pending.get(v) ?? []) resolve(result)
    pending.delete(v)
  }
  return { validator, settle, calls }
}

describe('dispose settles a validation in flight', () => {
  test('a field disposed mid-check resolves the revalidate() waiting on it', async () => {
    const check = manualAsync()
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'x', { validators: [check.validator] }),
    }))
    const pending = root.api.f.revalidate()
    root.api.f.dispose()
    expect(await settlesSoon(pending)).toBe('settled')
    expect(root.api.f.isValidating.value).toBe(false)
    root.dispose()
  })

  test('removing a row mid-submit lets the submission finish, and the next one is not busy', async () => {
    const check = manualAsync()
    const handler = vi.fn((value: { rows: string[] }) => value.rows.length)
    const root = build((ctx) => ({
      form: createForm(ctx, {
        rows: createFieldArray(
          ctx,
          (initial?: string) =>
            createField<string>(ctx, initial ?? '', { validators: [check.validator] }),
          { initial: ['a', 'b'] },
        ),
      }),
    }))
    const form = root.api.form

    const submitted = form.submit(handler)
    await tick() // the rows' re-validations are now in flight
    form.fields.rows.remove(1)
    check.settle('a', null)

    expect(await settlesSoon(submitted)).toBe('settled')
    expect(await submitted).toEqual({ ok: true, data: 1 })
    expect(handler).toHaveBeenCalledWith({ rows: ['a'] })
    expect(form.isSubmitting.value).toBe(false)

    const again = form.submit(handler)
    check.settle('a', null)
    expect((await again).ok).toBe(true)
    root.dispose()
  })

  test('a form disposed while its form-level check runs resolves submit() as disposed', async () => {
    const check = manualAsync()
    const handler = vi.fn()
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { a: createField<string>(ctx, 'x') },
        { validators: [(value) => check.validator(value.a)] },
      ),
    }))
    const submitted = root.api.form.submit(handler)
    await tick() // submit() now waits on the form-level validator
    root.dispose()
    expect(await settlesSoon(submitted)).toBe('settled')
    expect(await submitted).toEqual({ ok: false, reason: 'disposed' })
    expect(handler).not.toHaveBeenCalled()
    expect(root.api.form.isSubmitting.value).toBe(false)
  })

  test('a field array disposed while its array-level check runs resolves validate()', async () => {
    const check = manualAsync()
    const root = build((ctx) => ({
      rows: createFieldArray(ctx, (initial?: string) => createField<string>(ctx, initial ?? ''), {
        initial: ['a'],
        validators: [(items) => check.validator(items.join(','))],
      }),
    }))
    const validated = root.api.rows.validate()
    await tick()
    root.dispose()
    expect(await settlesSoon(validated)).toBe('settled')
    expect(root.api.rows.isValidating.value).toBe(false)
  })
})

describe('a throwing reactive initial()', () => {
  test('routes to onError instead of escaping into the write that re-ran it', () => {
    type Profile = { name: string } | { title: string }
    const profile = signal<Profile>({ name: 'ada' })
    const onError = vi.fn()
    const root = build(
      (ctx) => ({
        form: createForm(
          ctx,
          { name: createField<string>(ctx, '') },
          { initial: () => ({ name: (profile.value as { name: string }).name.toUpperCase() }) },
        ),
      }),
      onError,
    )
    expect(root.api.form.fields.name.value).toBe('ADA')

    expect(() => profile.set({ title: 'changed shape' })).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError)
    expect((onError.mock.calls[0]?.[1] as ErrorContext).kind).toBe('effect')
    expect(root.api.form.fields.name.value).toBe('ADA')

    // The thunk's dependencies survived the throw, so a good value re-seats.
    profile.set({ name: 'grace' })
    expect(root.api.form.fields.name.value).toBe('GRACE')
    root.dispose()
  })

  test('a throw on the first run reaches onError and leaves the construction seeds', () => {
    const onError = vi.fn()
    const root = build(
      (ctx) => ({
        form: createForm(
          ctx,
          { name: createField<string>(ctx, 'seed') },
          {
            initial: (): { name: string } => {
              throw new Error('initial boom')
            },
          },
        ),
      }),
      onError,
    )
    expect(root.api.form.fields.name.value).toBe('seed')
    expect(onError.mock.calls.map(([err]) => (err as Error).message)).toEqual(['initial boom'])
    root.dispose()
  })
})

describe('a late first initial value respects the dirty guard', () => {
  test("'when-clean' keeps an edit made while initial() was still undefined", () => {
    const data = signal<{ name: string } | undefined>(undefined)
    const root = build((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, '') }, { initial: () => data.value }),
    }))
    const form = root.api.form
    form.fields.name.set('typed')
    data.set({ name: 'server' })
    expect(form.fields.name.value).toBe('typed')
    expect(form.isDirty.value).toBe(true)
    // reset() re-reads initial(), so the loaded value is still one call away.
    form.reset()
    expect(form.fields.name.value).toBe('server')
    root.dispose()
  })

  test("'never' does not seat a first value over edits either, and 'always' does", () => {
    const data = signal<{ name: string } | undefined>(undefined)
    const root = build((ctx) => ({
      never: createForm(
        ctx,
        { name: createField<string>(ctx, '') },
        { initial: () => data.value, resetOnInitialChange: 'never' },
      ),
      always: createForm(
        ctx,
        { name: createField<string>(ctx, '') },
        { initial: () => data.value, resetOnInitialChange: 'always' },
      ),
    }))
    root.api.never.fields.name.set('typed')
    root.api.always.fields.name.set('typed')
    data.set({ name: 'server' })
    expect(root.api.never.fields.name.value).toBe('typed')
    expect(root.api.always.fields.name.value).toBe('server')
    root.dispose()
  })
})

describe('the first initial value seats the leaves the user has not edited', () => {
  type Contact = { name: string; email: string; phone: string }

  test('an edit before the record loads keeps its value, and the other fields fill', () => {
    const data = signal<Contact | undefined>(undefined)
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        {
          name: createField<string>(ctx, ''),
          email: createField<string>(ctx, ''),
          phone: createField<string>(ctx, ''),
        },
        { initial: () => data.value },
      ),
    }))
    const form = root.api.form
    form.fields.name.set('typed')
    data.set({ name: 'Ada', email: 'ada@example.com', phone: '555' })
    expect(form.value).toEqual({ name: 'typed', email: 'ada@example.com', phone: '555' })
    expect(form.dirtyFields.value).toEqual(['name'])
    // The edited field's baseline moved to the loaded value.
    form.fields.name.set('Ada')
    expect(form.isDirty.value).toBe(false)
    form.fields.name.set('typed')
    form.fields.name.reset()
    expect(form.fields.name.value).toBe('Ada')
    root.dispose()
  })

  test('a later value still respects the whole-form guard', () => {
    const data = signal<Contact | undefined>(undefined)
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        {
          name: createField<string>(ctx, ''),
          email: createField<string>(ctx, ''),
          phone: createField<string>(ctx, ''),
        },
        { initial: () => data.value },
      ),
    }))
    const form = root.api.form
    form.fields.name.set('typed')
    data.set({ name: 'Ada', email: 'ada@example.com', phone: '555' })
    data.set({ name: 'Ada', email: 'new@example.com', phone: '777' })
    expect(form.value).toEqual({ name: 'typed', email: 'ada@example.com', phone: '555' })
    root.dispose()
  })

  test('a default set in the factory stays, inside a nested form too', () => {
    type Profile = { name: string; address: { city: string; country: string } }
    const data = signal<Profile | undefined>(undefined)
    const root = build((ctx) => {
      const form = createForm(
        ctx,
        {
          name: createField<string>(ctx, ''),
          address: createForm(ctx, {
            city: createField<string>(ctx, ''),
            country: createField<string>(ctx, ''),
          }),
        },
        { initial: () => data.value },
      )
      form.set({ address: { country: 'UA' } })
      return { form }
    })
    const form = root.api.form
    data.set({ name: 'Ada', address: { city: 'Kyiv', country: 'PL' } })
    expect(form.value).toEqual({ name: 'Ada', address: { city: 'Kyiv', country: 'UA' } })
    form.reset()
    expect(form.value).toEqual({ name: 'Ada', address: { city: 'Kyiv', country: 'PL' } })
    root.dispose()
  })

  test('a field array with a row added before createForm keeps its rows', () => {
    const data = signal<{ name: string; tags: string[] } | undefined>(undefined)
    const root = build((ctx) => {
      const tags = createFieldArray(ctx, (initial?: string) =>
        createField<string>(ctx, initial ?? ''),
      )
      tags.add('draft')
      return {
        form: createForm(
          ctx,
          { name: createField<string>(ctx, ''), tags },
          { initial: () => data.value },
        ),
      }
    })
    const form = root.api.form
    data.set({ name: 'Ada', tags: ['a', 'b'] })
    expect(form.value).toEqual({ name: 'Ada', tags: ['draft'] })
    expect(form.fields.tags.isDirty.value).toBe(true)
    form.fields.tags.reset()
    expect(form.fields.tags.value).toEqual(['a', 'b'])
    expect(form.isDirty.value).toBe(false)
    root.dispose()
  })
})

describe("'never' after a reset() that seated the form", () => {
  test('a later initial value does not re-seat', () => {
    // `initial()` reads a plain variable, so only `tick` re-runs it.
    let record: { name: string } | undefined
    const tick = signal(0)
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { name: createField<string>(ctx, '') },
        {
          initial: () => {
            void tick.value
            return record
          },
          resetOnInitialChange: 'never',
        },
      ),
    }))
    const form = root.api.form
    record = { name: 'first' }
    form.reset()
    expect(form.fields.name.value).toBe('first')
    record = { name: 'second' }
    tick.set(1)
    expect(form.fields.name.value).toBe('first')
    root.dispose()
  })
})

describe('reset() reads initial() the way the reactive seat does', () => {
  test('a throw reaches onError, and the fields still reset to their baselines', () => {
    let fail = false
    const onError = vi.fn()
    const root = build(
      (ctx) => ({
        form: createForm(
          ctx,
          { name: createField<string>(ctx, '') },
          {
            initial: () => {
              if (fail) throw new Error('reset boom')
              return { name: 'seed' }
            },
          },
        ),
      }),
      onError,
    )
    const form = root.api.form
    form.fields.name.set('typed')
    fail = true
    expect(() => form.reset()).not.toThrow()
    expect(onError.mock.calls.map(([err]) => (err as Error).message)).toEqual(['reset boom'])
    expect((onError.mock.calls[0]?.[1] as ErrorContext).kind).toBe('effect')
    expect(form.fields.name.value).toBe('seed')
    root.dispose()
  })

  test('a reset() inside an effect does not subscribe the effect to what initial() reads', () => {
    const data = signal({ name: 'a' })
    let runs = 0
    const root = build((ctx) => {
      const form = createForm(
        ctx,
        { name: createField<string>(ctx, '') },
        { initial: () => data.value },
      )
      ctx.effect(() => {
        runs++
        form.reset()
      })
      return { form }
    })
    expect(runs).toBe(1)
    data.set({ name: 'b' })
    expect(runs).toBe(1)
    expect(root.api.form.fields.name.value).toBe('b')
    root.dispose()
  })
})

describe('async validators start only after every sync validator passes', () => {
  test('a field: a failing required() keeps the async check from being called', () => {
    const check = vi.fn(async (_v: string) => null)
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'ok', { validators: [required('Required'), check] }),
    }))
    expect(check).toHaveBeenCalledWith('ok', expect.anything())
    check.mockClear()
    root.api.f.set('')
    expect(check).not.toHaveBeenCalled()
    expect(root.api.f.errors.value).toEqual(['Required'])
    expect(root.api.f.isValidating.value).toBe(false)
    root.api.f.set('bob')
    expect(check).toHaveBeenCalledWith('bob', expect.anything())
    root.dispose()
  })

  test('a field: an async check is not called on the first pass when the value starts invalid', () => {
    // Declared `async`, so it counts as async before its first call, whatever
    // its place in the list.
    const calls: string[] = []
    async function check(v: string): Promise<string | null> {
      calls.push(v)
      return null
    }
    const root = build((ctx) => ({
      f: createField<string>(ctx, '', { validators: [check, required('Required')] }),
    }))
    expect(calls).toEqual([])
    expect(root.api.f.errors.value).toEqual(['Required'])
    root.dispose()
  })

  test('a field: a validator that returned a promise before counts as async from then on', () => {
    const calls: string[] = []
    const check = (v: string) => {
      calls.push(v)
      return Promise.resolve(null)
    }
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'ok', { validators: [required('Required'), check] }),
    }))
    root.api.f.set('')
    expect(calls).toEqual(['ok'])
    root.dispose()
  })

  test('a form and a field array skip their async validators on a sync failure', () => {
    const formCheck = vi.fn(async () => null)
    const arrayCheck = vi.fn(async () => null)
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        { a: createField<string>(ctx, 'ok') },
        { validators: [(v) => (v.a === '' ? 'a is empty' : null), formCheck] },
      ),
      rows: createFieldArray(ctx, (initial?: string) => createField<string>(ctx, initial ?? ''), {
        initial: ['x'],
        validators: [(items) => (items.length === 0 ? 'no rows' : null), arrayCheck],
      }),
    }))
    formCheck.mockClear()
    arrayCheck.mockClear()
    root.api.form.fields.a.set('')
    root.api.rows.remove(0)
    expect(formCheck).not.toHaveBeenCalled()
    expect(arrayCheck).not.toHaveBeenCalled()
    expect(root.api.form.topLevelErrors.value).toEqual(['a is empty'])
    expect(root.api.rows.topLevelErrors.value).toEqual(['no rows'])
    root.dispose()
  })
})

describe('field arrays release the lifecycle entries of the items they drop', () => {
  test('a removed field is disposed once, not again when the root disposes', () => {
    const created: Field<string>[] = []
    const root = build((ctx) => ({
      rows: createFieldArray(ctx, (initial?: string) => {
        const field = createField<string>(ctx, initial ?? '')
        vi.spyOn(field, 'dispose')
        created.push(field)
        return field
      }),
    }))
    for (let i = 0; i < 100; i++) {
      root.api.rows.add('x')
      root.api.rows.remove(0)
    }
    root.dispose()
    expect(created).toHaveLength(100)
    for (const field of created) expect(field.dispose).toHaveBeenCalledTimes(1)
  })

  test('a removed form item is disposed once, and reset() does not pile up entries', () => {
    const forms: Array<{ dispose: () => void }> = []
    const root = build((ctx) => ({
      rows: createFieldArray(
        ctx,
        (initial?: { name?: string }) => {
          const form = createForm(ctx, { name: createField<string>(ctx, initial?.name ?? '') })
          vi.spyOn(form, 'dispose')
          forms.push(form)
          return form
        },
        { initial: [{ name: 'a' }, { name: 'b' }] },
      ),
    }))
    root.api.rows.reset()
    root.api.rows.reset()
    root.api.rows.clear()
    root.dispose()
    expect(forms).toHaveLength(6)
    for (const form of forms) expect(form.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('reset() drops an async result still in flight', () => {
  test("under validateOn: 'submit', a result arriving after reset() does not land", async () => {
    const check = manualAsync()
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'x', { validators: [check.validator], validateOn: 'submit' }),
    }))
    const revalidated = root.api.f.revalidate()
    root.api.f.reset()
    await revalidated
    check.settle('x', 'taken')
    await tick()
    expect(root.api.f.errors.value).toEqual([])
    expect(root.api.f.isValid.value).toBe(true)
    root.dispose()
  })

  test('a reset that leaves the value unchanged drops the result too', async () => {
    const check = manualAsync()
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'x', { validators: [check.validator] }),
    }))
    expect(root.api.f.isValidating.value).toBe(true)
    root.api.f.reset()
    check.settle('x', 'taken')
    await tick()
    expect(root.api.f.errors.value).toEqual([])
    root.dispose()
  })
})

describe('form-level validators that target the same field', () => {
  test("fixing one rule keeps the other rule's message on the field", () => {
    const root = build((ctx) => {
      const inner = createForm(
        ctx,
        { b: createField<string>(ctx, '') },
        {
          validators: [
            (v): FormIssue[] => (v.b === '' ? [{ path: ['b'], message: 'inner: required' }] : []),
          ],
        },
      )
      const outer = createForm(
        ctx,
        { a: createField<string>(ctx, ''), inner },
        {
          validators: [
            (v): FormIssue[] =>
              v.a === 'x' ? [{ path: ['inner', 'b'], message: 'outer: conflict' }] : [],
          ],
        },
      )
      return { outer }
    })
    const { outer } = root.api
    const b = outer.fields.inner.fields.b
    expect(b.errors.value).toEqual(['inner: required'])

    outer.fields.a.set('x')
    expect(b.errors.value).toEqual(['inner: required', 'outer: conflict'])

    outer.fields.a.set('y')
    expect(b.errors.value).toEqual(['inner: required'])
    expect(b.isValid.value).toBe(false)
    expect(outer.isValid.value).toBe(false)

    b.set('filled')
    expect(b.errors.value).toEqual([])
    expect(outer.isValid.value).toBe(true)
    root.dispose()
  })

  test('two routers targeting the same nested form keep separate lists', () => {
    const root = build((ctx) => {
      const inner = createForm(ctx, { c: createField<string>(ctx, '') })
      const middle = createForm(
        ctx,
        { flag: createField<boolean>(ctx, true), inner },
        {
          validators: [
            (v): FormIssue[] => (v.flag ? [{ path: ['inner'], message: 'middle rule' }] : []),
          ],
        },
      )
      const outer = createForm(
        ctx,
        { flag: createField<boolean>(ctx, true), middle },
        {
          validators: [
            (v): FormIssue[] =>
              v.flag ? [{ path: ['middle', 'inner'], message: 'outer rule' }] : [],
          ],
        },
      )
      return { outer }
    })
    const inner = root.api.outer.fields.middle.fields.inner
    expect(inner.topLevelErrors.value).toEqual(['middle rule', 'outer rule'])
    root.api.outer.fields.flag.set(false)
    expect(inner.topLevelErrors.value).toEqual(['middle rule'])
    root.dispose()
  })
})

// JSON and API records spell "no nested object" as `null`. A nested form or
// field array cannot hold `null`, so it treats it as it treats `undefined`.
describe('a null for a nested form or field array', () => {
  function profileForm(ctx: Ctx, initial?: () => unknown) {
    return createForm(
      ctx,
      {
        name: createField<string | null>(ctx, 'n'),
        address: createForm(ctx, { street: createField<string>(ctx, 's') }),
        tags: createFieldArray(ctx, (i?: string) => createField<string>(ctx, i ?? ''), {
          initial: ['t'],
        }),
      },
      initial === undefined ? undefined : { initial: initial as never },
    )
  }

  test('set() leaves the subtree alone, and a field still takes null', () => {
    const root = build((ctx) => ({ form: profileForm(ctx) }))
    const { form } = root.api
    expect(() => form.set({ name: null, address: null, tags: null } as never)).not.toThrow()
    expect(form.peek()).toEqual({ name: null, address: { street: 's' }, tags: ['t'] })
    root.dispose()
  })

  test('setAsInitial() does the same', () => {
    const root = build((ctx) => ({ form: profileForm(ctx) }))
    const { form } = root.api
    expect(() => form.setAsInitial({ address: null, tags: null } as never)).not.toThrow()
    expect(form.peek()).toEqual({ name: 'n', address: { street: 's' }, tags: ['t'] })
    root.dispose()
  })

  test('a reactive initial() with a null nested record seats the rest', () => {
    const onError = vi.fn()
    const record = signal<unknown>(undefined)
    const root = build((ctx) => ({ form: profileForm(ctx, () => record.value) }), onError)
    record.set({ name: 'Ada', address: null, tags: null })
    expect(root.api.form.peek()).toEqual({
      name: 'Ada',
      address: { street: 's' },
      tags: ['t'],
    })
    expect(onError).not.toHaveBeenCalled()
    root.dispose()
  })
})
