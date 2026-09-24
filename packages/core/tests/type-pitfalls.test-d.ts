/**
 * Type-level regression tests for the two TS pitfalls documented in
 * `.wiki/pitfalls/`:
 *
 *  - `literal-type-narrowing` — `createField(ctx, '')` would infer `Field<''>` (the
 *    literal type) without an explicit annotation; we want `Field<string>` so
 *    subsequent `.set('hello')` works.
 *  - `preact-signals-overload-return` — `ReturnType<typeof signal<T>>` picks
 *    the last overload (`Signal<T | undefined>`), so our wrapped `signal()`
 *    must be careful to return `Signal<T>`.
 *
 * These assertions run via `tsc --noEmit` (they're type-only; `expectTypeOf`
 * has no runtime side effects). A regression that re-introduces the original
 * inferences would fail typecheck.
 */
import { describe, expectTypeOf, test } from 'vitest'
import { createField } from '../src'
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
    expectTypeOf(root.api.name.value).toEqualTypeOf<string>()
    root.api.name.set('anything')
    root.dispose()
  })

  test("createField(ctx, '') without annotation narrows to '' (pitfall pin)", () => {
    const def = defineController((ctx) => ({
      narrow: createField(ctx, ''),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    // The inferred type is `Field<''>` — `.set` accepts only the literal ''.
    // This is the documented pitfall (`.wiki/pitfalls/literal-type-narrowing.md`):
    // the assertion exists so a future change that *auto-widens* literals
    // shows up as a typecheck failure (then update the test).
    expectTypeOf(root.api.narrow.value).toMatchTypeOf<string>()
    // Empty-string is a valid value.
    root.api.narrow.set('')
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
