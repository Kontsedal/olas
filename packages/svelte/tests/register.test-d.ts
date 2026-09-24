// Type-level test: augmenting `Register` types `getRoot()` without a generic.
// Checked by `tsc` (the package typecheck), not run by vitest.
import { createRoot, defineController, signal } from '@kontsedal/olas-core'
import { expectTypeOf } from 'vitest'
import { getRoot } from '../src'

const root = createRoot(
  defineController(() => ({ count: signal(0), label: 'x' })),
  { deps: {} },
)

declare module '../src' {
  interface Register {
    root: typeof root
  }
}

export function typedInit(): void {
  const api = getRoot()
  expectTypeOf(api.label).toEqualTypeOf<string>()
  expectTypeOf(api.count.value).toEqualTypeOf<number>()
  // An explicit type argument still wins, for code that names another api.
  const other = getRoot<{ other: boolean }>()
  expectTypeOf(other.other).toEqualTypeOf<boolean>()
}
