import { describe, expect, expectTypeOf, test, vi } from 'vitest'
import { createField, createFieldArray, createForm } from '../src'
import { createRoot, defineController } from '../src/controller'
import { required } from '../src/forms'
import { queryEngine } from '../src/query/engine'

const emptyDeps = {}

describe('form.submit lifecycle', () => {
  test('happy path: validates, calls handler, bumps submitCount, clears isSubmitting', async () => {
    const handler = vi.fn(async (value: { name: string }) => ({ id: 'srv-1', ...value }))
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, 'Alice', { validators: [required()] }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    expect(root.api.form.submitCount.value).toBe(0)
    expect(root.api.form.isSubmitting.value).toBe(false)

    const promise = root.api.form.submit(handler)
    // submitCount bumps immediately, before the handler awaits.
    expect(root.api.form.submitCount.value).toBe(1)
    expect(root.api.form.isSubmitting.value).toBe(true)

    const result = await promise
    expect(result).toEqual({ ok: true, data: { id: 'srv-1', name: 'Alice' } })
    expect(handler).toHaveBeenCalledWith({ name: 'Alice' })
    expect(root.api.form.isSubmitting.value).toBe(false)
    expect(root.api.form.submitError.value).toBeUndefined()

    root.dispose()
  })

  test('skips handler when form is invalid; marks all touched and returns ok:false', async () => {
    const handler = vi.fn()
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, '', { validators: [required()] }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    expect(root.api.form.fields.name.touched.value).toBe(false)
    const result = await root.api.form.submit(handler)
    expect(result).toEqual({ ok: false, reason: 'invalid' })
    expect(handler).not.toHaveBeenCalled()
    expect(root.api.form.fields.name.touched.value).toBe(true)
    expect(root.api.form.submitCount.value).toBe(1)
    expect(root.api.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('skipping pre-submit validation runs the handler even when invalid', async () => {
    const handler = vi.fn(async () => 'sent')
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        name: createField<string>(ctx, '', { validators: [required()] }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    const result = await root.api.form.submit(handler, { validateBeforeSubmit: false })
    expect(result.ok).toBe(true)
    expect(handler).toHaveBeenCalled()
    expect(root.api.form.fields.name.touched.value).toBe(false)

    root.dispose()
  })

  test('captures thrown handler errors into submitError', async () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, 'Alice') }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    const boom = new Error('server 500')
    const result = await root.api.form.submit(async () => {
      throw boom
    })
    expect(result).toEqual({ ok: false, reason: 'error', error: boom })
    expect(root.api.form.submitError.value).toBe(boom)
    expect(root.api.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('onError: "rethrow" propagates the throw to the caller', async () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, 'Alice') }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    const boom = new Error('boom')
    await expect(
      root.api.form.submit(
        async () => {
          throw boom
        },
        { onError: 'rethrow' },
      ),
    ).rejects.toBe(boom)
    // submitError is still recorded even on rethrow.
    expect(root.api.form.submitError.value).toBe(boom)
    expect(root.api.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('resetOnSuccess clears the form after the handler resolves', async () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, '') }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    root.api.form.fields.name.set('Alice')
    expect(root.api.form.fields.name.isDirty.value).toBe(true)
    await root.api.form.submit(async () => undefined, {
      validateBeforeSubmit: false,
      resetOnSuccess: true,
    })
    expect(root.api.form.fields.name.value).toBe('')
    expect(root.api.form.fields.name.isDirty.value).toBe(false)

    root.dispose()
  })

  test("double-submit guard: parallel submit() resolves ok:false with reason 'busy'", async () => {
    let releaseFirst!: () => void
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, 'Alice') }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    // Skip validation so the handler runs as soon as the submit body kicks
    // off — without this, the handler awaits validate() and `releaseFirst`
    // wouldn't be wired by the time the second submit returns.
    const first = root.api.form.submit(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
      { validateBeforeSubmit: false },
    )
    // Yield once so the synchronous-front portion of `first` runs (sets
    // isSubmitting=true, calls the handler which captures releaseFirst).
    await Promise.resolve()
    expect(root.api.form.isSubmitting.value).toBe(true)
    const second = await root.api.form.submit(async () => 'ignored')
    expect(second).toEqual({ ok: false, reason: 'busy' })
    releaseFirst()
    await first
    expect(root.api.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('submitError clears at the start of each new submit', async () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, 'Alice') }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    await root.api.form.submit(async () => {
      throw new Error('first failure')
    })
    expect(root.api.form.submitError.value).toBeInstanceOf(Error)

    // Pre-write: submitError is set. The next submit must clear it
    // synchronously (before the handler awaits).
    let observedDuringSubmit: unknown = 'not-checked'
    const second = root.api.form.submit(async () => {
      observedDuringSubmit = root.api.form.submitError.value
      return 'ok'
    })
    expect(root.api.form.submitError.value).toBeUndefined()
    await second
    expect(observedDuringSubmit).toBeUndefined()

    root.dispose()
  })
})

describe('form.setErrors / field.setErrors', () => {
  test('field.setErrors pins server errors that survive validator re-runs', () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, 'Alice', { validators: [required()] }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    root.api.name.setErrors(['Username already taken'])
    expect(root.api.name.errors.value).toContain('Username already taken')

    // Trigger a validator re-run by changing & changing back to a valid value.
    root.api.name.set('Alice')
    // setErrors are cleared on next user write (see contract).
    expect(root.api.name.errors.value).not.toContain('Username already taken')

    root.dispose()
  })

  test('field.setErrors merges with validator errors (validator first)', () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, '', { validators: [required('Required')] }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    // Validator error from `required` on empty + server error.
    root.api.name.setErrors(['Server says no'])
    const errs = root.api.name.errors.value
    expect(errs).toContain('Required')
    expect(errs).toContain('Server says no')
    expect(errs.indexOf('Required')).toBeLessThan(errs.indexOf('Server says no'))

    root.dispose()
  })

  test('field.setErrors([]) clears the server-error channel without touching validators', () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, '', { validators: [required('Required')] }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    root.api.name.setErrors(['Pinned'])
    expect(root.api.name.errors.value).toContain('Pinned')
    root.api.name.setErrors([])
    expect(root.api.name.errors.value).not.toContain('Pinned')
    // Validator error is unchanged.
    expect(root.api.name.errors.value).toContain('Required')

    root.dispose()
  })

  test('form.setErrors routes by dot-separated path through nested forms', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        user: createForm(ctx, {
          email: createField<string>(ctx, 'e@x.com'),
        }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    root.api.form.setErrors({ 'user.email': ['Already in use'] })
    expect(root.api.form.fields.user.fields.email.errors.value).toContain('Already in use')

    root.dispose()
  })

  test('form.setErrors routes by numeric index into field arrays', () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, {
        tags: createFieldArray(ctx, (initial: string | undefined) =>
          createField(ctx, initial ?? ''),
        ),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    root.api.form.fields.tags.add('first')
    root.api.form.fields.tags.add('second')

    root.api.form.setErrors({ 'tags.1': ['Reserved word'] })
    const second = root.api.form.fields.tags.at(1)
    expect(second?.errors.value).toContain('Reserved word')

    // First item unaffected.
    expect(root.api.form.fields.tags.at(0)?.errors.value).not.toContain('Reserved word')

    root.dispose()
  })

  test('reset() clears server errors too', () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, 'Alice'),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    root.api.name.setErrors(['Pinned'])
    expect(root.api.name.errors.value).toContain('Pinned')
    root.api.name.reset()
    expect(root.api.name.errors.value).toEqual([])

    root.dispose()
  })
})

describe('Form.submit — the result narrows on ok, then on reason', () => {
  test('a disposed form resolves disposed without running the handler', async () => {
    const handler = vi.fn()
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, 'x') }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const form = root.api.form
    root.dispose()
    expect(await form.submit(handler)).toEqual({ ok: false, reason: 'disposed' })
    expect(handler).not.toHaveBeenCalled()
  })

  test('the union narrows: data only on ok, error only on reason error', async () => {
    const def = defineController((ctx) => ({
      form: createForm(ctx, { name: createField<string>(ctx, 'x') }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const result = await root.api.form.submit(() => 42)
    if (result.ok) {
      expectTypeOf(result.data).toEqualTypeOf<number>()
    } else if (result.reason === 'error') {
      expectTypeOf(result.error).toBeUnknown()
    } else {
      expectTypeOf(result.reason).toEqualTypeOf<'invalid' | 'busy' | 'disposed'>()
    }
    expect(result).toEqual({ ok: true, data: 42 })
    root.dispose()
  })
})
