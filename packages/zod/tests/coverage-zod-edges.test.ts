import { createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createZodForm, zodValidatorAsync } from '../src'

const emptyDeps = {}

/** Build a root whose api is one `createZodForm(ctx, schema)`; read each leaf's `.value`. */
function leafValues(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const def = defineController((ctx) => ({ form: createZodForm(ctx, schema) }))
  const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
  const fields = root.api.form.fields as unknown as Record<string, { value: unknown }>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) out[key] = fields[key]?.value
  root.dispose()
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('zodValidatorAsync — abort handling', () => {
  test('an already-aborted signal rejects with AbortError before the schema runs', async () => {
    const check = vi.fn(async () => true)
    const v = zodValidatorAsync(z.string().refine(check, { message: 'nope' }))
    const controller = new AbortController()
    controller.abort()

    const err = await Promise.resolve(v('x', controller.signal)).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DOMException)
    expect((err as Error).name).toBe('AbortError')
    expect((err as Error).message).toBe('Aborted')
    expect(check).not.toHaveBeenCalled()
  })

  test('aborting while an async refinement is pending rejects with AbortError and detaches the listener', async () => {
    let release: (ok: boolean) => void = () => {}
    const schema = z.string().refine(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      { message: 'nope' },
    )
    const v = zodValidatorAsync(schema)
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const pending = Promise.resolve(v('x', controller.signal)).catch((e: unknown) => e)
    controller.abort()
    const err = await pending

    expect((err as Error).name).toBe('AbortError')
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    // The parse settling after the abort changes nothing (no late rejection).
    release(false)
    await Promise.resolve()
  })

  test('a signal that reports aborted once the parse settles still rejects (superseded pass never writes back)', async () => {
    // A signal-shaped object whose `aborted` flips during the parse without
    // dispatching an `abort` event — the race resolves with the parse result,
    // and only the post-parse `signal.aborted` check can catch it.
    const listeners: Array<() => void> = []
    const fakeSignal = {
      aborted: false,
      addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    }
    const schema = z.string().refine(async () => {
      fakeSignal.aborted = true
      return true
    })
    const v = zodValidatorAsync(schema)

    const err = await Promise.resolve(v('x', fakeSignal as unknown as AbortSignal)).catch(
      (e: unknown) => e,
    )

    expect((err as Error).name).toBe('AbortError')
    expect(listeners).toHaveLength(1)
    expect(fakeSignal.removeEventListener).toHaveBeenCalledWith('abort', listeners[0])
  })

  test('falls back to a tagged Error named AbortError when DOMException is unavailable', async () => {
    vi.stubGlobal('DOMException', undefined)
    const v = zodValidatorAsync(z.string())
    const controller = new AbortController()
    controller.abort()

    const err = await Promise.resolve(v('x', controller.signal)).catch((e: unknown) => e)

    expect(Object.getPrototypeOf(err)).toBe(Error.prototype)
    expect((err as Error).name).toBe('AbortError')
    expect((err as Error).message).toBe('Aborted')
  })
})

describe('createZodForm — duplicate zod copy detection', () => {
  test('a Zod 3-shaped foreign schema (only `_def`) also triggers the warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const foreign = { _def: { typeName: 'ZodObject' } } as unknown as z.ZodType
    const schema = z.object({ nested: foreign })

    const values = leafValues(schema as z.ZodObject<z.ZodRawShape>)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/TWO copies of `zod`/)
    // It degrades to a flat field with the unknown-type fallback initial.
    expect(values.nested).toBeUndefined()
  })

  test('schemas from this zod copy never warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    leafValues(z.object({ a: z.string(), b: z.object({ c: z.number() }), d: z.array(z.boolean()) }))
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('createZodForm — default initial per leaf type', () => {
  test('bigint, literal, tuple, record, map and set leaves', () => {
    const values = leafValues(
      z.object({
        big: z.bigint(),
        single: z.literal(5),
        multi: z.literal(['x', 'y']),
        pair: z.tuple([z.string(), z.number()]),
        dict: z.record(z.string(), z.number()),
        lookup: z.map(z.string(), z.number()),
        unique: z.set(z.string()),
      }),
    )

    expect(values.big).toBe(0n)
    expect(values.single).toBe(5)
    expect(values.multi).toBe('x')
    expect(values.pair).toEqual([])
    expect(values.dict).toEqual({})
    expect(values.lookup).toBeInstanceOf(Map)
    expect((values.lookup as Map<string, number>).size).toBe(0)
    expect(values.unique).toBeInstanceOf(Set)
    expect((values.unique as Set<string>).size).toBe(0)
  })

  test('an array behind a transform is a flat field seeded from the input array schema', () => {
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, z.object({ count: z.array(z.string()).transform((a) => a.length) })),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const count = root.api.form.fields.count as unknown as { value: unknown; items?: unknown }

    // A ZodPipe is not a ZodArray, so no FieldArray is built…
    expect(count.items).toBeUndefined()
    // …but the initial comes from the pipe's INPUT (an array) → [].
    expect(count.value).toEqual([])
    root.dispose()
  })

  test('an explicit initial wins over the per-type empty value', () => {
    const def = defineController((ctx) => ({
      form: createZodForm(ctx, z.object({ big: z.bigint(), unique: z.set(z.string()) }), {
        initial: { big: 7n, unique: new Set(['a']) },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.form.fields.big.value).toBe(7n)
    expect([...(root.api.form.fields.unique.value as Set<string>)]).toEqual(['a'])
    root.dispose()
  })
})
