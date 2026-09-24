/**
 * Type-level regression tests for the two TS pitfalls documented in
 * `.wiki/pitfalls/`:
 *
 *  - `literal-type-narrowing` — `createField(ctx, '')` widens to
 *    `Field<string>`, but with a `validators` array it keeps the literal
 *    (`Field<''>`), and `createField(ctx, null)` is `Field<null>`. Annotate
 *    the type parameter in both cases.
 *  - `preact-signals-overload-return` — `ReturnType<typeof signal<T>>` picks
 *    the last overload (`Signal<T | undefined>`), so our wrapped `signal()`
 *    must be careful to return `Signal<T>`.
 *
 * These assertions run via `tsc --noEmit` (they're type-only; `expectTypeOf`
 * has no runtime side effects). A regression that re-introduces the original
 * inferences would fail typecheck.
 */
import { describe, expectTypeOf, test } from 'vitest'
import { createField, email, required } from '../src'
import { createRoot, defineController } from '../src/controller'
import { queryEngine } from '../src/query/engine'
import { type Signal, signal } from '../src/signals'

describe('type pitfall: literal-type-narrowing', () => {
  test("createField<string>(ctx, '') widens value to string", () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, ''),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    // Explicit annotation widens — `.set('anything')` is valid.
    expectTypeOf<typeof root.api.name.value>().toEqualTypeOf<string>()
    root.api.name.set('anything')
    root.dispose()
  })

  test("createField(ctx, '') with no validators widens to string", () => {
    const def = defineController((ctx) => ({
      bare: createField(ctx, ''),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    // `expectTypeOf<typeof x>()`, not `expectTypeOf(x)`: inferring the type
    // argument from a value widens a literal, so `expectTypeOf(x)` cannot see
    // one. That is how an earlier version of this pin passed while wrong.
    expectTypeOf<typeof root.api.bare.value>().toEqualTypeOf<string>()
    root.api.bare.set('anything')
    root.dispose()
  })

  test("createField(ctx, '', { validators }) keeps the literal '' (pitfall pin)", () => {
    // The documented pitfall (`.wiki/pitfalls/literal-type-narrowing.md`). A
    // validator typed for `string` gives `T` a second, contravariant
    // inference site, and TypeScript then keeps the literal `''` from the
    // initial value. If this changes, update the pitfall page.
    defineController((ctx) => {
      const validated = createField(ctx, '', { validators: [required(), email()] })
      expectTypeOf<typeof validated.value>().toEqualTypeOf<''>()
      return { validated }
    })
  })

  test('createField(ctx, null) is a field that only holds null (pitfall pin)', () => {
    const def = defineController((ctx) => ({
      empty: createField(ctx, null),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    expectTypeOf<typeof root.api.empty.value>().toEqualTypeOf<null>()
    root.dispose()
  })
})

describe('type pitfall: preact-signals-overload-return', () => {
  test('signal<T>(x) returns Signal<T>, not Signal<T | undefined>', () => {
    const s = signal<number>(7)
    expectTypeOf(s).toEqualTypeOf<Signal<number>>()
    expectTypeOf(s.value).toEqualTypeOf<number>()
  })

  test('signal(union-with-null) preserves the precise type', () => {
    // The wrapper signature should NOT silently widen to `T | undefined`.
    const s = signal<string | null>(null)
    expectTypeOf(s.value).toEqualTypeOf<string | null>()
  })
})
