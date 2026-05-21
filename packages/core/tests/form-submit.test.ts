import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { required } from '../src/forms'

const emptyDeps = {}

describe('form.submit lifecycle', () => {
  test('happy path: validates, calls handler, bumps submitCount, clears isSubmitting', async () => {
    const handler = vi.fn(async (value: { name: string }) => ({ id: 'srv-1', ...value }))
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('Alice', [required()]),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    expect(root.form.submitCount.value).toBe(0)
    expect(root.form.isSubmitting.value).toBe(false)

    const promise = root.form.submit(handler)
    // submitCount bumps immediately, before the handler awaits.
    expect(root.form.submitCount.value).toBe(1)
    expect(root.form.isSubmitting.value).toBe(true)

    const result = await promise
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ id: 'srv-1', name: 'Alice' })
    expect(handler).toHaveBeenCalledWith({ name: 'Alice' })
    expect(root.form.isSubmitting.value).toBe(false)
    expect(root.form.submitError.value).toBeUndefined()

    root.dispose()
  })

  test('skips handler when form is invalid; marks all touched and returns ok:false', async () => {
    const handler = vi.fn()
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('', [required()]),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    expect(root.form.fields.name.touched.value).toBe(false)
    const result = await root.form.submit(handler)
    expect(result.ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(root.form.fields.name.touched.value).toBe(true)
    expect(root.form.submitCount.value).toBe(1)
    expect(root.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('skipping pre-submit validation runs the handler even when invalid', async () => {
    const handler = vi.fn(async () => 'sent')
    const def = defineController((ctx) => ({
      form: ctx.form({
        name: ctx.field<string>('', [required()]),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    const result = await root.form.submit(handler, { validateBeforeSubmit: false })
    expect(result.ok).toBe(true)
    expect(handler).toHaveBeenCalled()
    expect(root.form.fields.name.touched.value).toBe(false)

    root.dispose()
  })

  test('captures thrown handler errors into submitError', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('Alice') }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    const boom = new Error('server 500')
    const result = await root.form.submit(async () => {
      throw boom
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe(boom)
    expect(root.form.submitError.value).toBe(boom)
    expect(root.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('onError: "rethrow" propagates the throw to the caller', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('Alice') }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    const boom = new Error('boom')
    await expect(
      root.form.submit(
        async () => {
          throw boom
        },
        { onError: 'rethrow' },
      ),
    ).rejects.toBe(boom)
    // submitError is still recorded even on rethrow.
    expect(root.form.submitError.value).toBe(boom)
    expect(root.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('resetOnSuccess clears the form after the handler resolves', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('') }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    root.form.fields.name.set('Alice')
    expect(root.form.fields.name.isDirty.value).toBe(true)
    await root.form.submit(async () => undefined, {
      validateBeforeSubmit: false,
      resetOnSuccess: true,
    })
    expect(root.form.fields.name.value).toBe('')
    expect(root.form.fields.name.isDirty.value).toBe(false)

    root.dispose()
  })

  test('double-submit guard: parallel submit() returns ok:false with an error', async () => {
    let releaseFirst!: () => void
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('Alice') }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    // Skip validation so the handler runs as soon as the submit body kicks
    // off — without this, the handler awaits validate() and `releaseFirst`
    // wouldn't be wired by the time the second submit returns.
    const first = root.form.submit(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
      { validateBeforeSubmit: false },
    )
    // Yield once so the synchronous-front portion of `first` runs (sets
    // isSubmitting=true, calls the handler which captures releaseFirst).
    await Promise.resolve()
    expect(root.form.isSubmitting.value).toBe(true)
    const second = await root.form.submit(async () => 'ignored')
    expect(second.ok).toBe(false)
    expect(second.error).toBeInstanceOf(Error)
    expect((second.error as Error).message).toMatch(/already in progress/)
    releaseFirst()
    await first
    expect(root.form.isSubmitting.value).toBe(false)

    root.dispose()
  })

  test('submitError clears at the start of each new submit', async () => {
    const def = defineController((ctx) => ({
      form: ctx.form({ name: ctx.field<string>('Alice') }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    await root.form.submit(async () => {
      throw new Error('first failure')
    })
    expect(root.form.submitError.value).toBeInstanceOf(Error)

    // Pre-write: submitError is set. The next submit must clear it
    // synchronously (before the handler awaits).
    let observedDuringSubmit: unknown = 'not-checked'
    const second = root.form.submit(async () => {
      observedDuringSubmit = root.form.submitError.value
      return 'ok'
    })
    expect(root.form.submitError.value).toBeUndefined()
    await second
    expect(observedDuringSubmit).toBeUndefined()

    root.dispose()
  })
})

describe('form.setErrors / field.setErrors', () => {
  test('field.setErrors pins server errors that survive validator re-runs', () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>('Alice', [required()]),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    root.name.setErrors(['Username already taken'])
    expect(root.name.errors.value).toContain('Username already taken')

    // Trigger a validator re-run by changing & changing back to a valid value.
    root.name.set('Alice')
    // setErrors are cleared on next user write (see contract).
    expect(root.name.errors.value).not.toContain('Username already taken')

    root.dispose()
  })

  test('field.setErrors merges with validator errors (validator first)', () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>('', [required('Required')]),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    // Validator error from `required` on empty + server error.
    root.name.setErrors(['Server says no'])
    const errs = root.name.errors.value
    expect(errs).toContain('Required')
    expect(errs).toContain('Server says no')
    expect(errs.indexOf('Required')).toBeLessThan(errs.indexOf('Server says no'))

    root.dispose()
  })

  test('field.setErrors([]) clears the server-error channel without touching validators', () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>('', [required('Required')]),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    root.name.setErrors(['Pinned'])
    expect(root.name.errors.value).toContain('Pinned')
    root.name.setErrors([])
    expect(root.name.errors.value).not.toContain('Pinned')
    // Validator error is unchanged.
    expect(root.name.errors.value).toContain('Required')

    root.dispose()
  })

  test('form.setErrors routes by dot-separated path through nested forms', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        user: ctx.form({
          email: ctx.field<string>('e@x.com'),
        }),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    root.form.setErrors({ 'user.email': ['Already in use'] })
    expect(root.form.fields.user.fields.email.errors.value).toContain('Already in use')

    root.dispose()
  })

  test('form.setErrors routes by numeric index into field arrays', () => {
    const def = defineController((ctx) => ({
      form: ctx.form({
        tags: ctx.fieldArray((initial: string | undefined) => ctx.field(initial ?? '')),
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    root.form.fields.tags.add('first')
    root.form.fields.tags.add('second')

    root.form.setErrors({ 'tags.1': ['Reserved word'] })
    const second = root.form.fields.tags.at(1)
    expect(second?.errors.value).toContain('Reserved word')

    // First item unaffected.
    expect(root.form.fields.tags.at(0)?.errors.value).not.toContain('Reserved word')

    root.dispose()
  })

  test('reset() clears server errors too', () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>('Alice'),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    root.name.setErrors(['Pinned'])
    expect(root.name.errors.value).toContain('Pinned')
    root.name.reset()
    expect(root.name.errors.value).toEqual([])

    root.dispose()
  })
})
