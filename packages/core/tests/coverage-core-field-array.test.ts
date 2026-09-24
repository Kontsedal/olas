import { describe, expect, test, vi } from 'vitest'
import {
  type Ctx,
  createField,
  createFieldArray,
  createForm,
  createRoot,
  defineController,
  type Field,
  type FieldArrayValidator,
  type Validator,
} from '../src'

function build<Api>(factory: (ctx: Ctx) => Api) {
  return createRoot(defineController(factory), { deps: {} })
}

const required: Validator<string> = (v) => (v ? null : 'required')

function tags(initial: string[], validators?: FieldArrayValidator<Field<string>>[]) {
  const root = build((ctx) => ({
    tags: createFieldArray(ctx, (value?: string) => createField<string>(ctx, value ?? ''), {
      initial,
      validators,
    }),
  }))
  return { root, tags: root.api.tags }
}

type Line = { sku?: string; qty?: number }

function lines(initial: Line[]) {
  const root = build((ctx) => ({
    lines: createFieldArray(
      ctx,
      (value?: Line) =>
        createForm(ctx, {
          sku: createField<string>(ctx, value?.sku ?? '', { validators: [required] }),
          qty: createField<number>(ctx, value?.qty ?? 1),
        }),
      { initial },
    ),
  }))
  return { root, lines: root.api.lines }
}

describe('FieldArray of forms', () => {
  test('errors carries each item form’s error shape', () => {
    const { root, lines: arr } = lines([{ sku: 'A' }, { sku: '' }])
    expect(arr.errors.value).toEqual([{ sku: undefined, qty: undefined }, { sku: ['required'] }])
    root.dispose()
  })

  test('validate() re-runs every item form', async () => {
    const { root, lines: arr } = lines([{ sku: 'A' }, { sku: '' }])
    await expect(arr.validate()).resolves.toBe(false)
    arr.at(1)?.fields.sku.set('B')
    await expect(arr.validate()).resolves.toBe(true)
    root.dispose()
  })
})

describe('FieldArray aggregates over item state', () => {
  test('an item edit makes the array dirty without any structural change', () => {
    const { root, tags: arr } = tags(['a', 'b'])
    expect(arr.isDirty.value).toBe(false)
    arr.at(1)?.set('changed')
    expect(arr.isDirty.value).toBe(true)
    arr.at(1)?.set('b')
    expect(arr.isDirty.value).toBe(false)
    root.dispose()
  })

  test('touched follows any item; markAllTouched touches every field item', () => {
    const { root, tags: arr } = tags(['a', 'b'])
    expect(arr.touched.value).toBe(false)
    arr.at(0)?.markTouched()
    expect(arr.touched.value).toBe(true)
    arr.markAllTouched()
    expect(arr.at(1)?.touched.value).toBe(true)
    root.dispose()
  })

  test('isValidating follows an item with an in-flight async validator', async () => {
    let resolve!: (r: string | null) => void
    const root = build((ctx) => ({
      arr: createFieldArray(ctx, (value?: string) =>
        createField<string>(ctx, value ?? '', {
          validators: [
            () =>
              new Promise<string | null>((r) => {
                resolve = r
              }),
          ],
        }),
      ),
    }))
    const arr = root.api.arr
    arr.add('x')
    expect(arr.isValidating.value).toBe(true)
    resolve(null)
    await vi.waitFor(() => expect(arr.isValidating.value).toBe(false))
    expect(arr.isValid.value).toBe(true)
    root.dispose()
  })

  test('peek() and subscribe() expose the items’ values', () => {
    const { root, tags: arr } = tags(['a'])
    const seen: string[][] = []
    const off = arr.subscribe((v) => seen.push([...v]))
    arr.add('b')
    off()
    arr.add('c')
    expect(seen).toEqual([['a'], ['a', 'b']])
    expect(arr.peek()).toEqual(['a', 'b', 'c'])
    root.dispose()
  })
})

describe('FieldArray structural edits out of range', () => {
  test('remove() past the end leaves the items alone', () => {
    const { root, tags: arr } = tags(['a', 'b'])
    const before = arr.items.value
    arr.remove(5)
    expect(arr.value).toEqual(['a', 'b'])
    expect(arr.items.value[0]).toBe(before[0])
    expect(arr.items.value[1]).toBe(before[1])
    root.dispose()
  })

  test('move() from past the end leaves the order alone', () => {
    const { root, tags: arr } = tags(['a', 'b'])
    arr.move(7, 0)
    expect(arr.value).toEqual(['a', 'b'])
    root.dispose()
  })
})

describe('array-level validators', () => {
  test('a validator throwing a non-Error surfaces its string form', () => {
    const { root, tags: arr } = tags(
      ['a'],
      [
        () => {
          throw 'array rule exploded'
        },
      ],
    )
    expect(arr.topLevelErrors.value).toEqual(['array rule exploded'])
    expect(arr.isValid.value).toBe(false)
    root.dispose()
  })

  test('validate() with sync array validators resolves without waiting', async () => {
    const { root, tags: arr } = tags(['a'], [(v) => (v.length > 1 ? 'one tag only' : null)])
    await expect(arr.validate()).resolves.toBe(true)
    arr.add('b')
    await expect(arr.validate()).resolves.toBe(false)
    expect(arr.topLevelErrors.value).toEqual(['one tag only'])
    root.dispose()
  })

  test('validate() whose array is disposed mid-flight does not re-run the array validators', async () => {
    const rule = vi.fn(() => null)
    const { root, tags: arr } = tags(['a'], [rule])
    expect(rule).toHaveBeenCalledTimes(1)
    const pending = arr.validate()
    arr.dispose()
    await expect(pending).resolves.toBe(true)
    expect(rule).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('own top-level errors merge with ones a parent form routed onto the array', () => {
    const root = build((ctx) => {
      const list = createFieldArray(
        ctx,
        (value?: string) => createField<string>(ctx, value ?? ''),
        {
          initial: ['a', 'b'],
          validators: [(v) => (v.length > 1 ? 'one tag only' : null)],
        },
      )
      return {
        form: createForm(
          ctx,
          { list },
          {
            validators: [
              (v) => (v.list.includes('b') ? [{ path: ['list'], message: 'no b allowed' }] : []),
            ],
          },
        ),
      }
    })
    const list = root.api.form.fields.list
    expect(list.topLevelErrors.value).toEqual(['one tag only', 'no b allowed'])
    list.remove(0)
    expect(list.topLevelErrors.value).toEqual(['no b allowed'])
    list.remove(0)
    expect(list.topLevelErrors.value).toEqual([])
    root.dispose()
  })
})

describe('FieldArray after dispose()', () => {
  test('every mutating method is a no-op', async () => {
    const { root, tags: arr } = tags(['a', 'b'])
    arr.dispose()
    arr.dispose()

    arr.add('c')
    arr.insert(0, 'z')
    arr.remove(0)
    arr.move(0, 1)
    arr.clear()
    arr.set(['x'])
    arr.setAsInitial(['y'])
    arr.reset()

    expect(arr.value).toEqual(['a', 'b'])
    expect(arr.isDirty.value).toBe(false)
    await expect(arr.validate()).resolves.toBe(true)
    root.dispose()
  })
})
