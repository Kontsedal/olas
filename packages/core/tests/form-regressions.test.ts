import { describe, expect, test, vi } from 'vitest'
import {
  batch,
  type Ctx,
  createField,
  createFieldArray,
  createForm,
  createRoot,
  debouncedValidator,
  defineController,
  type ErrorContext,
  effect,
  type Field,
  type FormIssue,
  required,
  signal,
} from '../src'
import { copyPlainData } from '../src/forms/field'

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
    expect((onError.mock.calls[0]?.[1] as ErrorContext | undefined)?.kind).toBe('effect')
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
    expect((onError.mock.calls[0]?.[1] as ErrorContext | undefined)?.kind).toBe('effect')
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

// submit() validates first in every calling context (§8.6). Inside a batch()
// or an effect, the write's validator effect runs when that ends, not when
// revalidate() bumps its trigger.
describe('submit() inside batch() or an effect waits for the async check', () => {
  function usernameForm() {
    const check = manualAsync()
    const root = build((ctx) => {
      const username = createField<string>(ctx, '', { validators: [check.validator] })
      return { form: createForm(ctx, { username }) }
    })
    return { check, root, form: root.api.form }
  }

  test('batch(): the handler does not run while the check is pending', async () => {
    const { check, root, form } = usernameForm()
    check.settle('', null)
    await tick()
    const save = vi.fn()
    let submitted: Promise<unknown> = Promise.resolve()
    batch(() => {
      form.fields.username.set('taken')
      submitted = form.submit(save)
    })
    await tick()
    expect(save).not.toHaveBeenCalled()
    check.settle('taken', 'Username taken')
    expect(await submitted).toEqual({ ok: false, reason: 'invalid' })
    expect(save).not.toHaveBeenCalled()
    root.dispose()
  })

  test('an effect: the handler does not run while the check is pending', async () => {
    const { check, root, form } = usernameForm()
    check.settle('', null)
    await tick()
    const save = vi.fn()
    const go = signal(false)
    let submitted: Promise<unknown> = Promise.resolve()
    const stop = effect(() => {
      if (!go.value) return
      form.fields.username.set('taken')
      submitted = form.submit(save)
    })
    go.set(true)
    await tick()
    expect(save).not.toHaveBeenCalled()
    check.settle('taken', null)
    expect(await submitted).toEqual({ ok: true, data: undefined })
    expect(save).toHaveBeenCalledWith({ username: 'taken' })
    stop()
    root.dispose()
  })

  test('field.revalidate() inside batch() resolves with the pass it asked for', async () => {
    const check = manualAsync()
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'x', { validators: [check.validator] }),
    }))
    check.settle('x', null)
    await tick()
    let revalidated: Promise<boolean> = Promise.resolve(true)
    batch(() => {
      root.api.f.set('y')
      revalidated = root.api.f.revalidate()
    })
    expect(await settlesSoon(revalidated)).toBe('pending')
    check.settle('y', 'bad')
    expect(await revalidated).toBe(false)
    root.dispose()
  })
})

describe('debouncedValidator whose fn fails synchronously', () => {
  test('a sync throw settles the field, reports to onError and shows the message', async () => {
    const onError = vi.fn()
    const root = build(
      (ctx) => ({
        f: createField<string>(ctx, 'x', {
          validators: [
            debouncedValidator((): Promise<string | null> => {
              throw new Error('fn boom')
            }, 0),
          ],
        }),
      }),
      onError,
    )
    const { f } = root.api
    expect(await settlesSoon(f.revalidate())).toBe('settled')
    expect(f.isValidating.value).toBe(false)
    expect(f.errors.value).toEqual(['fn boom'])
    expect(f.isValid.value).toBe(false)
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls.every((c) => c[1].kind === 'effect')).toBe(true)
    expect(String(onError.mock.calls[0]![0])).toMatch(/fn boom/)
    root.dispose()
  })

  test('a thrown string shows as the message and still reaches onError', async () => {
    const onError = vi.fn()
    const root = build(
      (ctx) => ({
        f: createField<string>(ctx, 'x', {
          validators: [
            debouncedValidator((): Promise<string | null> => {
              throw 'plain string'
            }, 0),
          ],
        }),
      }),
      onError,
    )
    expect(await root.api.f.revalidate()).toBe(false)
    expect(root.api.f.errors.value).toEqual(['plain string'])
    expect(onError).toHaveBeenCalled()
    root.dispose()
  })

  test('as a form-level or array-level validator it lands on the top level and reports', async () => {
    const onError = vi.fn()
    const failing = () =>
      debouncedValidator((): Promise<string | null> => {
        throw new Error('level boom')
      }, 0)
    const root = build(
      (ctx) => ({
        form: createForm(
          ctx,
          {
            tags: createFieldArray(ctx, (i?: string) => createField<string>(ctx, i ?? ''), {
              validators: [failing()],
            }),
          },
          { validators: [failing()] },
        ),
      }),
      onError,
    )
    const { form } = root.api
    // Two debounce rounds, the array's then the form's: it settles, later.
    expect(await form.validate()).toBe(false)
    expect(form.topLevelErrors.value).toEqual(['level boom'])
    expect(form.fields.tags.topLevelErrors.value).toEqual(['level boom'])
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2)
    root.dispose()
  })

  test('an AbortError rejection at the form or array level shows nothing', async () => {
    const aborts = async (): Promise<string | null> => {
      throw new DOMException('Aborted', 'AbortError')
    }
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        {
          tags: createFieldArray(ctx, () => createField<string>(ctx, ''), { validators: [aborts] }),
        },
        { validators: [aborts] },
      ),
    }))
    expect(await root.api.form.validate()).toBe(true)
    expect(root.api.form.flatErrors.value).toEqual([])
    root.dispose()
  })

  test('a non-promise return does the same, and a form submit is not left busy', async () => {
    const onError = vi.fn()
    const root = build(
      (ctx) => ({
        form: createForm(ctx, {
          f: createField<string>(ctx, 'x', {
            validators: [debouncedValidator((() => 'nope') as never, 0)],
          }),
        }),
      }),
      onError,
    )
    const { form } = root.api
    const save = vi.fn()
    const first = form.submit(save)
    expect(await settlesSoon(first)).toBe('settled')
    expect(await first).toEqual({ ok: false, reason: 'invalid' })
    expect(form.isSubmitting.value).toBe(false)
    expect(form.fields.f.errors.value[0]).toMatch(/must return a promise/)
    expect(onError).toHaveBeenCalled()
    expect(await form.submit(save)).toEqual({ ok: false, reason: 'invalid' })
    expect(save).not.toHaveBeenCalled()
    root.dispose()
  })
})

describe('dirtyFields and structural field-array changes', () => {
  function tagsForm(ctx: Ctx) {
    return createForm(ctx, {
      name: createField<string>(ctx, ''),
      tags: createFieldArray(ctx, (i?: string) => createField<string>(ctx, i ?? ''), {
        initial: ['a', 'b'],
      }),
    })
  }

  test('an added row lists the array path, as isDirty counts it', () => {
    const root = build((ctx) => ({ form: tagsForm(ctx) }))
    const { form } = root.api
    form.fields.tags.add('c')
    expect(form.isDirty.value).toBe(true)
    expect(form.dirtyFields.value).toEqual(['tags'])
    // Under a structurally dirty array, an item edit adds no index path.
    form.fields.tags.at(0)?.set('z')
    expect(form.dirtyFields.value).toEqual(['tags'])
    form.fields.name.set('n')
    expect(form.dirtyFields.value).toEqual(['name', 'tags'])
    form.reset()
    expect(form.dirtyFields.value).toEqual([])
    // A structurally clean array still lists the item it holds dirty.
    form.fields.tags.at(1)?.set('y')
    expect(form.dirtyFields.value).toEqual(['tags[1]'])
    root.dispose()
  })

  test('remove and move count, in a nested form too', () => {
    const root = build((ctx) => ({
      form: createForm(ctx, { inner: tagsForm(ctx) }),
    }))
    const tags = root.api.form.fields.inner.fields.tags
    tags.move(0, 1)
    expect(root.api.form.dirtyFields.value).toEqual(['inner.tags'])
    root.api.form.reset()
    tags.remove(0)
    expect(root.api.form.dirtyFields.value).toEqual(['inner.tags'])
    root.dispose()
  })
})

describe('a null row in a field array of forms', () => {
  function linesForm(ctx: Ctx, record: { value: unknown }, bad?: string) {
    return createForm(
      ctx,
      {
        lines: createFieldArray(ctx, (initial?: { sku?: string }) => {
          if (bad !== undefined && initial?.sku === bad) throw new Error(`cannot build ${bad}`)
          return createForm(ctx, { sku: createField<string>(ctx, 'none') }, { initial })
        }),
      },
      { initial: () => record.value as never },
    )
  }

  test('a reactive initial with a null row builds that row from its schema defaults', () => {
    const onError = vi.fn()
    const record = signal<unknown>(undefined)
    const root = build((ctx) => ({ form: linesForm(ctx, record) }), onError)
    expect(() => record.set({ lines: [{ sku: 'A' }, null] })).not.toThrow()
    expect(root.api.form.peek()).toEqual({ lines: [{ sku: 'A' }, { sku: 'none' }] })
    expect(root.api.form.isDirty.value).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    root.dispose()
  })

  test('form.set(null) leaves the form alone', () => {
    const root = build((ctx) => ({
      form: createForm(ctx, { sku: createField<string>(ctx, 'none') }),
    }))
    expect(() => root.api.form.set(null as never)).not.toThrow()
    expect(root.api.form.peek()).toEqual({ sku: 'none' })
    root.dispose()
  })

  test('an item form built with initial: null keeps its seeds', () => {
    const root = build((ctx) => ({
      item: createForm(ctx, { sku: createField<string>(ctx, 'none') }, { initial: null as never }),
    }))
    expect(root.api.item.peek()).toEqual({ sku: 'none' })
    root.api.item.reset()
    expect(root.api.item.peek()).toEqual({ sku: 'none' })
    root.dispose()
  })

  test('a throw while seating a reactive initial reaches onError, and the rows stay whole', () => {
    const onError = vi.fn()
    const record = signal<unknown>({ lines: [{ sku: 'A' }] })
    const root = build((ctx) => ({ form: linesForm(ctx, record, 'X') }), onError)
    expect(() => record.set({ lines: [{ sku: 'B' }, { sku: 'X' }] })).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1].kind).toBe('effect')
    expect(root.api.form.peek()).toEqual({ lines: [{ sku: 'A' }] })
    // A later good value still seats.
    record.set({ lines: [{ sku: 'C' }] })
    expect(root.api.form.peek()).toEqual({ lines: [{ sku: 'C' }] })
    root.dispose()
  })
})

describe('setErrors with a path that names a nested form or field array', () => {
  function orderForm(ctx: Ctx) {
    return createForm(ctx, {
      address: createForm(ctx, { street: createField<string>(ctx, 's') }),
      lines: createFieldArray(
        ctx,
        (i?: { sku?: string }) => createForm(ctx, { sku: createField<string>(ctx, i?.sku ?? '') }),
        { initial: [{ sku: 'A' }] },
      ),
    })
  }

  test("the messages land in that node's own topLevelErrors", () => {
    const root = build((ctx) => ({ form: orderForm(ctx) }))
    const { form } = root.api
    form.setErrors({
      address: ['Not deliverable'],
      lines: ['Too many lines'],
      'lines.0': ['Add a SKU'],
      '': ['Order rejected'],
    })
    expect(form.fields.address.topLevelErrors.value).toEqual(['Not deliverable'])
    expect(form.fields.lines.topLevelErrors.value).toEqual(['Too many lines'])
    expect(form.fields.lines.at(0)?.topLevelErrors.value).toEqual(['Add a SKU'])
    expect(form.topLevelErrors.value).toEqual(['Order rejected'])
    expect(form.isValid.value).toBe(false)
    expect(form.flatErrors.value).toEqual([
      { path: '', errors: ['Order rejected'] },
      { path: 'address', errors: ['Not deliverable'] },
      { path: 'lines', errors: ['Too many lines'] },
      { path: 'lines[0]', errors: ['Add a SKU'] },
    ])
    root.dispose()
  })

  test("a change to the node clears them, as a field's next set() clears its own", () => {
    const root = build((ctx) => ({ form: orderForm(ctx) }))
    const { form } = root.api
    form.setErrors({ address: ['Not deliverable'], lines: ['Too many lines'] })
    form.fields.address.fields.street.set('t')
    expect(form.fields.address.topLevelErrors.value).toEqual([])
    expect(form.fields.lines.topLevelErrors.value).toEqual(['Too many lines'])
    form.fields.lines.remove(0)
    expect(form.fields.lines.topLevelErrors.value).toEqual([])
    expect(form.isValid.value).toBe(true)
    root.dispose()
  })

  test('a disposed nested node ignores them, and an empty list clears an array', () => {
    const root = build((ctx) => ({ form: orderForm(ctx) }))
    const { form } = root.api
    form.setErrors({ lines: ['x'] })
    form.setErrors({ lines: [] })
    expect(form.fields.lines.topLevelErrors.value).toEqual([])
    form.fields.address.dispose()
    form.fields.lines.dispose()
    form.setErrors({ address: ['late'], lines: ['late'] })
    expect(form.fields.address.topLevelErrors.value).toEqual([])
    expect(form.fields.lines.topLevelErrors.value).toEqual([])
    root.dispose()
  })

  test('setErrors with an empty list and reset() clear them', () => {
    const root = build((ctx) => ({ form: orderForm(ctx) }))
    const { form } = root.api
    form.setErrors({ address: ['x'], '': ['y'] })
    form.setErrors({ address: [] })
    expect(form.fields.address.topLevelErrors.value).toEqual([])
    expect(form.topLevelErrors.value).toEqual(['y'])
    form.reset()
    expect(form.topLevelErrors.value).toEqual([])
    root.dispose()
  })
})

describe('reset() leaves a field in the state a fresh field would be in', () => {
  test('a pristine required() field reads invalid after a reset, as it did before', () => {
    const root = build((ctx) => {
      const name = createField<string>(ctx, '', { validators: [required('Required')] })
      return { name, form: createForm(ctx, { name }) }
    })
    const { name, form } = root.api
    expect(name.errors.value).toEqual(['Required'])
    name.reset()
    expect(name.errors.value).toEqual(['Required'])
    expect(name.isValid.value).toBe(false)
    form.reset()
    expect(name.errors.value).toEqual(['Required'])
    expect(form.isValid.value).toBe(false)
    root.dispose()
  })

  test('a reset back to the initial value runs the validators once, not twice', () => {
    const calls: string[] = []
    const root = build((ctx) => ({
      f: createField<string>(ctx, '', {
        validators: [
          (v) => {
            calls.push(v)
            return v === '' ? 'Required' : null
          },
        ],
      }),
    }))
    root.api.f.set('a')
    calls.length = 0
    root.api.f.reset()
    expect(calls).toEqual([''])
    expect(root.api.f.errors.value).toEqual(['Required'])
    root.dispose()
  })

  test('a no-op reset does not call an async validator again', () => {
    const check = manualAsync()
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'x', { validators: [required(), check.validator] }),
    }))
    expect(check.calls).toEqual(['x'])
    root.api.f.reset()
    expect(check.calls).toEqual(['x'])
    expect(root.api.f.isValidating.value).toBe(false)
    expect(root.api.f.errors.value).toEqual([])
    root.dispose()
  })

  test("validateOn: 'blur' re-locks: no errors until the next blur", () => {
    const root = build((ctx) => ({
      f: createField<string>(ctx, '', { validators: [required('Required')], validateOn: 'blur' }),
    }))
    root.api.f.markTouched()
    expect(root.api.f.errors.value).toEqual(['Required'])
    root.api.f.reset()
    expect(root.api.f.errors.value).toEqual([])
    root.dispose()
  })
})

describe('state members typed ReadSignal expose no write access', () => {
  test('field, form and field array state cannot be written through the public members', () => {
    const root = build((ctx) => {
      const f = createField<string>(ctx, '')
      const tags = createFieldArray(ctx, (i?: string) => createField<string>(ctx, i ?? ''), {
        initial: ['a'],
      })
      return { f, tags, form: createForm(ctx, { f, tags }) }
    })
    const { f, tags, form } = root.api
    const members: Array<[string, unknown]> = [
      ['field.touched', f.touched],
      ['field.isDirty', f.isDirty],
      ['field.isValidating', f.isValidating],
      ['form.isSubmitting', form.isSubmitting],
      ['form.submitCount', form.submitCount],
      ['form.submitError', form.submitError],
      ['array.items', tags.items],
    ]
    for (const [name, member] of members) {
      const writable = member as { set?: unknown; update?: unknown; value: unknown }
      expect([name, writable.set, writable.update]).toEqual([name, undefined, undefined])
      expect(() => {
        writable.value = 1
      }).toThrow(TypeError)
    }
    // Stable identity, so an adapter hook keeps one subscription.
    expect(f.touched).toBe(f.touched)
    expect(tags.items).toBe(tags.items)
    // And they still read and react.
    f.markTouched()
    expect(f.touched.value).toBe(true)
    tags.add('b')
    expect(tags.items.value).toHaveLength(2)
    root.dispose()
  })
})

// Svelte compiles `bind:value={$person.first}` on a raw Field to an in-place
// assignment on the value the store handed out, then `set` with that same
// object: `store_mutate(store, $person.first = v, $person)`. A Svelte store
// counts every object write as a change (`safe_not_equal`).
describe('an object value edited in place and set back, as a Svelte nested bind does', () => {
  function bindWrite<T extends object>(
    field: { peek(): T; set(v: T): void },
    edit: (v: T) => void,
  ) {
    const v = field.peek()
    edit(v)
    field.set(v)
  }
  type Person = { first: string; last: string; address: { city: string } }
  const ada = (): Person => ({ first: 'Ada', last: 'Lovelace', address: { city: 'London' } })

  test('set() of the same object notifies, re-validates and marks the field dirty', () => {
    const checked: string[] = []
    const root = build((ctx) => ({
      person: createField<Person>(ctx, ada(), {
        validators: [
          (v) => {
            checked.push(v.first)
            return v.first === '' ? 'Required' : null
          },
        ],
      }),
    }))
    const { person } = root.api
    const heard: string[] = []
    const stop = person.subscribeChanges((v) => heard.push(v.first))
    bindWrite(person, (v) => {
      v.first = ''
    })
    expect(heard).toEqual([''])
    expect(checked.at(-1)).toBe('')
    expect(person.errors.value).toEqual(['Required'])
    expect(person.isDirty.value).toBe(true)
    stop()
    root.dispose()
  })

  test('reset() restores the baseline, at every depth, and a later edit does not reach it', () => {
    const root = build((ctx) => ({ person: createField<Person>(ctx, ada()) }))
    const { person } = root.api
    bindWrite(person, (v) => {
      v.first = 'Grace'
      v.address.city = 'Arlington'
    })
    person.reset()
    expect(person.peek()).toEqual(ada())
    expect(person.isDirty.value).toBe(false)
    bindWrite(person, (v) => {
      v.address.city = 'Paris'
    })
    expect(person.isDirty.value).toBe(true)
    person.reset()
    expect(person.peek()).toEqual(ada())
    root.dispose()
  })

  test('setAsInitial() keeps its own baseline too', () => {
    const root = build((ctx) => ({ person: createField<Person>(ctx, ada()) }))
    const { person } = root.api
    const loaded = { first: 'Alan', last: 'Turing', address: { city: 'Wilmslow' } }
    person.setAsInitial(loaded)
    expect(person.peek()).toBe(loaded)
    expect(person.isDirty.value).toBe(false)
    bindWrite(person, (v) => {
      v.first = 'A.'
    })
    expect(person.isDirty.value).toBe(true)
    person.reset()
    expect(person.peek()).toEqual({ first: 'Alan', last: 'Turing', address: { city: 'Wilmslow' } })
    root.dispose()
  })

  test('a fresh field is clean and holds the object it was given; a primitive same value is no change', () => {
    const given = ada()
    const root = build((ctx) => ({
      person: createField<Person>(ctx, given),
      name: createField<string>(ctx, 'x'),
    }))
    expect(root.api.person.peek()).toBe(given)
    expect(root.api.person.isDirty.value).toBe(false)
    const heard: string[] = []
    const stop = root.api.name.subscribeChanges((v) => heard.push(v))
    root.api.name.set('x')
    expect(heard).toEqual([])
    stop()
    root.dispose()
  })

  test('a class instance, a Date and a Map keep their identity through reset()', () => {
    const when = new Date(0)
    const tags = new Map([['a', 1]])
    const root = build((ctx) => ({
      when: createField<Date>(ctx, when),
      tags: createField<Map<string, number>>(ctx, tags),
    }))
    root.api.when.set(new Date(1))
    root.api.when.reset()
    expect(root.api.when.peek()).toBe(when)
    root.api.tags.reset()
    expect(root.api.tags.peek()).toBe(tags)
    root.dispose()
  })

  test('in a form: the form hears the edit, is dirty, and its reset restores the value', () => {
    const initial = { person: ada() }
    const root = build((ctx) => ({
      form: createForm(ctx, { person: createField<Person>(ctx, ada()) }, { initial }),
    }))
    const { form } = root.api
    const seen: string[] = []
    const stop = form.subscribeChanges((v) => seen.push(v.person.first))
    bindWrite(form.fields.person, (v) => {
      v.first = 'Grace'
    })
    expect(seen).toEqual(['Grace'])
    expect(form.isDirty.value).toBe(true)
    expect(form.dirtyFields.value).toEqual(['person'])
    form.reset()
    expect(form.peek()).toEqual({ person: ada() })
    // After a reset the field holds a copy of the form's baseline, so a
    // second edit does not reach the baseline either.
    bindWrite(form.fields.person, (v) => {
      v.first = 'Hedy'
    })
    form.reset()
    expect(form.peek().person.first).toBe('Ada')
    stop()
    root.dispose()
  })

  test("in a field array: reset() rebuilds from the array's own baseline", () => {
    const root = build((ctx) => ({
      people: createFieldArray(ctx, (i?: Person) => createField<Person>(ctx, i ?? ada()), {
        initial: [ada()],
      }),
    }))
    const { people } = root.api
    const first = people.at(0)
    if (first === undefined) throw new Error('no item')
    bindWrite(first, (v) => {
      v.first = 'Grace'
    })
    people.reset()
    expect(people.peek()).toEqual([ada()])
    root.dispose()
  })

  test('a reactive initial that hands back the same objects does not re-run the validators', () => {
    const record = signal<{ person: Person }>({ person: ada() })
    let runs = 0
    const root = build((ctx) => ({
      form: createForm(
        ctx,
        {
          person: createField<Person>(ctx, ada(), {
            validators: [
              () => {
                runs++
                return null
              },
            ],
          }),
        },
        { initial: () => record.value },
      ),
    }))
    const before = runs
    // A structurally shared refetch: a new record around the same nested object.
    record.set({ person: record.peek().person })
    expect(runs).toBe(before)
    expect(root.api.form.isDirty.value).toBe(false)
    root.dispose()
  })
})

describe('copyPlainData, the baseline copy', () => {
  test('copies plain objects and arrays at every depth and keeps the rest by reference', () => {
    const when = new Date(0)
    const source = { list: [1, { deep: true }], when, tags: new Map([['a', 1]]) }
    const copy = copyPlainData(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
    expect(copy.list).not.toBe(source.list)
    expect(copy.list[1]).not.toBe(source.list[1])
    expect(copy.when).toBe(when)
    expect(copy.tags).toBe(source.tags)
    expect(copyPlainData('text')).toBe('text')
  })

  test('keeps holes, a null prototype, an own __proto__ key and a cycle', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point
    const sparse = [1, , 3]
    expect(1 in copyPlainData(sparse)).toBe(false)

    const bare = Object.assign(Object.create(null), { a: 1 }) as Record<string, unknown>
    expect(Object.getPrototypeOf(copyPlainData(bare))).toBe(null)

    const parsed = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    const copied = copyPlainData(parsed)
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
    expect(Object.hasOwn(copied, '__proto__')).toBe(true)

    const loop: { self?: unknown; items: unknown[] } = { items: [] }
    loop.self = loop
    loop.items.push(loop)
    const cycle = copyPlainData(loop)
    expect(cycle.self).toBe(cycle)
    expect(cycle.items[0]).toBe(cycle)
  })
})
