import { describe, expect, test, vi } from 'vitest'
import {
  type Ctx,
  createField,
  createForm,
  createRoot,
  defineController,
  type ErrorContext,
  type Validator,
} from '../src'
import { fakeField } from '../src/testing'

/** Build an engine-less root around `factory` and return its handle. */
function build<Api>(
  factory: (ctx: Ctx) => Api,
  onError?: (err: unknown, context: ErrorContext) => void,
) {
  return createRoot(defineController(factory), { deps: {}, onError })
}

/** A validator whose every call returns a promise the test settles by hand. */
function manualAsync<T>() {
  const pending: Array<(r: string | null) => void> = []
  const validator: Validator<T> = () =>
    new Promise<string | null>((resolve) => {
      pending.push(resolve)
    })
  return { validator, pending }
}

describe('Field.set — structural dirtiness', () => {
  test('arrays compare element-wise: same elements are clean, any difference is dirty', () => {
    const root = build((ctx) => ({ f: createField<number[]>(ctx, [1, 2]) }))
    const f = root.api.f
    f.set([1, 2])
    expect(f.isDirty.value).toBe(false)
    f.set([1, 2, 3])
    expect(f.isDirty.value).toBe(true)
    f.set([1, 3])
    expect(f.isDirty.value).toBe(true)
    f.set([1, 2])
    expect(f.isDirty.value).toBe(false)
    root.dispose()
  })

  test('an array and a plain object are never equal, in either direction', () => {
    const root = build((ctx) => ({
      fromArray: createField<unknown>(ctx, [1]),
      fromObject: createField<unknown>(ctx, { 0: 1 }),
    }))
    root.api.fromArray.set({ 0: 1 })
    expect(root.api.fromArray.isDirty.value).toBe(true)
    root.api.fromObject.set([1])
    expect(root.api.fromObject.isDirty.value).toBe(true)
    root.dispose()
  })

  test('an object value against a primitive initial is dirty', () => {
    const root = build((ctx) => ({ f: createField<unknown>(ctx, 5) }))
    root.api.f.set({})
    expect(root.api.f.isDirty.value).toBe(true)
    root.dispose()
  })

  test('plain objects compare by keys, recursively', () => {
    const root = build((ctx) => ({
      f: createField<Record<string, unknown>>(ctx, { a: 1, nested: { b: 1 } }),
    }))
    const f = root.api.f
    f.set({ a: 1, nested: { b: 1 } })
    expect(f.isDirty.value).toBe(false)
    // Different key count.
    f.set({ a: 1, nested: { b: 1 }, extra: true })
    expect(f.isDirty.value).toBe(true)
    // Same key count, different key names.
    f.set({ a: 1, other: { b: 1 } })
    expect(f.isDirty.value).toBe(true)
    // Same keys, a nested value differs.
    f.set({ a: 1, nested: { b: 2 } })
    expect(f.isDirty.value).toBe(true)
    root.dispose()
  })

  test('null-prototype objects are walked like plain objects', () => {
    const make = (n: number) => Object.assign(Object.create(null) as Record<string, number>, { n })
    const root = build((ctx) => ({ f: createField<Record<string, number>>(ctx, make(1)) }))
    root.api.f.set(make(1))
    expect(root.api.f.isDirty.value).toBe(false)
    root.api.f.set(make(2))
    expect(root.api.f.isDirty.value).toBe(true)
    root.dispose()
  })

  test('class instances fall back to reference identity', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    const initial = new Point(1)
    const root = build((ctx) => ({ f: createField<unknown>(ctx, initial) }))
    const f = root.api.f
    // Structurally identical, but a different instance: dirty.
    f.set(new Point(1))
    expect(f.isDirty.value).toBe(true)
    // The same instance: clean.
    f.set(initial)
    expect(f.isDirty.value).toBe(false)
    // A plain object with the same shape as the class instance: dirty.
    f.set({ x: 1 })
    expect(f.isDirty.value).toBe(true)
    root.dispose()
  })
})

describe('Field after dispose()', () => {
  test('every mutating method is a no-op and revalidate() resolves the last validity', async () => {
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'a', { validators: [(v) => (v === '' ? 'Required' : null)] }),
    }))
    const f = root.api.f
    f.set('b')
    f.markTouched()
    f.dispose()
    // Idempotent.
    f.dispose()

    f.set('')
    f.setErrors(['server'])
    f.setAsInitial('z')
    f.reset()
    f.markTouched()

    expect(f.value).toBe('b')
    expect(f.errors.value).toEqual([])
    expect(f.isDirty.value).toBe(true)
    expect(f.touched.value).toBe(true)
    await expect(f.revalidate()).resolves.toBe(true)
    root.dispose()
  })

  test('a disposed field inside a form ignores errors routed by a form-level validator', () => {
    const root = build((ctx) => {
      const a = createField<string>(ctx, 'ok')
      const b = createField<string>(ctx, '')
      const form = createForm(
        ctx,
        { a, b },
        {
          validators: [(v) => (v.a === 'bad' ? [{ path: ['b'], message: 'b is wrong' }] : [])],
        },
      )
      return { form }
    })
    const { a, b } = root.api.form.fields
    b.dispose()
    a.set('bad')
    expect(b.errors.value).toEqual([])
    root.dispose()
  })
})

describe('Field.setAsInitial', () => {
  test('clears server errors: a fresh baseline makes the old response irrelevant', () => {
    const root = build((ctx) => ({ f: createField<string>(ctx, 'ada') }))
    const f = root.api.f
    f.setErrors(['Username taken'])
    expect(f.errors.value).toEqual(['Username taken'])
    f.setAsInitial('grace')
    expect(f.errors.value).toEqual([])
    expect(f.value).toBe('grace')
    expect(f.isDirty.value).toBe(false)
    root.dispose()
  })

  test('clears errors a form-level validator routed onto the field, until the next form run', () => {
    const root = build((ctx) => {
      const a = createField<string>(ctx, 'ok')
      const b = createField<string>(ctx, '')
      return {
        form: createForm(
          ctx,
          { a, b },
          {
            validators: [
              (v) => (v.a.startsWith('bad') ? [{ path: ['b'], message: 'b is wrong' }] : []),
            ],
          },
        ),
      }
    })
    const { a, b } = root.api.form.fields
    a.set('bad')
    expect(b.errors.value).toEqual(['b is wrong'])
    // Re-anchoring to the same value leaves the form value unchanged, so only
    // the field's own clearing is observed here.
    b.setAsInitial('')
    expect(b.errors.value).toEqual([])
    // The next form-level run recomputes the routed error.
    a.set('bad again')
    expect(b.errors.value).toEqual(['b is wrong'])
    root.dispose()
  })

  test('a routed error cleared by reset() stays cleared when the rule is later fixed', () => {
    const root = build((ctx) => {
      const a = createField<string>(ctx, 'ok')
      const b = createField<string>(ctx, '')
      return {
        form: createForm(
          ctx,
          { a, b },
          {
            validators: [(v) => (v.a === 'bad' ? [{ path: ['b'], message: 'b is wrong' }] : [])],
          },
        ),
      }
    })
    const { a, b } = root.api.form.fields
    a.set('bad')
    expect(b.errors.value).toEqual(['b is wrong'])
    b.reset()
    expect(b.errors.value).toEqual([])
    // The next form-level run clears its last target again — already empty.
    a.set('ok')
    expect(b.errors.value).toEqual([])
    expect(root.api.form.isValid.value).toBe(true)
    root.dispose()
  })
})

describe('Field validator results', () => {
  test('a sync FormIssue[] on a leaf collapses to its messages', () => {
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'x', {
        validators: [
          () => [
            { path: ['deep'], message: 'first' },
            { path: [], message: 'second' },
          ],
        ],
      }),
    }))
    expect(root.api.f.errors.value).toEqual(['first', 'second'])
    expect(root.api.f.isValid.value).toBe(false)
    root.dispose()
  })

  test('a validator that throws a non-Error surfaces its string form and reaches onError', () => {
    const onError = vi.fn()
    const root = build(
      (ctx) => ({
        f: createField<string>(ctx, 'x', {
          validators: [
            () => {
              throw 'validator exploded'
            },
          ],
        }),
      }),
      onError,
    )
    expect(root.api.f.errors.value).toEqual(['validator exploded'])
    expect(onError).toHaveBeenCalledWith(
      'validator exploded',
      expect.objectContaining({ kind: 'effect', controllerPath: ['root'] }),
    )
    root.dispose()
  })

  test('an async validator rejecting with AbortError contributes no error', async () => {
    const root = build((ctx) => ({
      f: createField<string>(ctx, 'x', {
        validators: [() => Promise.reject(new DOMException('Aborted', 'AbortError'))],
      }),
    }))
    const f = root.api.f
    expect(f.isValidating.value).toBe(true)
    await vi.waitFor(() => expect(f.isValidating.value).toBe(false))
    expect(f.errors.value).toEqual([])
    expect(f.isValid.value).toBe(true)
    root.dispose()
  })

  test('revalidate() during an in-flight pass waits for the pass it starts', async () => {
    const { validator, pending } = manualAsync<string>()
    const root = build((ctx) => ({ f: createField<string>(ctx, 'x', { validators: [validator] }) }))
    const f = root.api.f
    expect(pending).toHaveLength(1)
    expect(f.isValidating.value).toBe(true)

    let settled: boolean | undefined
    const result = f.revalidate().then((v) => {
      settled = v
    })
    // revalidate() started a second pass, superseding the first.
    expect(pending).toHaveLength(2)
    // The superseded pass resolving does not settle the field.
    pending[0]?.(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.isValidating.value).toBe(true)
    expect(settled).toBeUndefined()

    pending[1]?.('Taken')
    await result
    expect(settled).toBe(false)
    expect(f.errors.value).toEqual(['Taken'])
    root.dispose()
  })
})

describe('Field as a ReadSignal', () => {
  test('peek() reads without tracking; subscribe() fires now and on every change', () => {
    const root = build((ctx) => ({ f: createField<string>(ctx, 'a') }))
    const f = root.api.f
    expect(f.peek()).toBe('a')
    const seen: string[] = []
    const off = f.subscribe((v) => seen.push(v))
    f.set('b')
    off()
    f.set('c')
    expect(seen).toEqual(['a', 'b'])
    expect(f.peek()).toBe('c')
    root.dispose()
  })
})

describe('a form holding a fake field', () => {
  test('aggregates the fake without needing the internal binding hooks', () => {
    const root = build((ctx) => ({
      form: createForm(ctx, {
        name: fakeField('Ada'),
        age: createField<number>(ctx, 36),
      }),
    }))
    const form = root.api.form
    expect(form.value).toEqual({ name: 'Ada', age: 36 })
    form.fields.name.set('Grace')
    expect(form.value).toEqual({ name: 'Grace', age: 36 })
    expect(form.isValid.value).toBe(true)
    root.dispose()
  })
})
