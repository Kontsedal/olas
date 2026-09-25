/**
 * Type-level pin for the `deps` check on `createRoot` (SPEC §20.3, §20.8).
 *
 * This file augments `AmbientDeps`, and an augmentation reaches every file in
 * its TypeScript program. So it compiles in a program of its own,
 * `tsconfig.ambient-deps.json`, which core's `typecheck` script runs after the
 * main one. The main `tsconfig.json` excludes it, and the rest of core's tests
 * keep the unaugmented `AmbientDeps`.
 *
 * It imports `@kontsedal/olas-core` by name, which resolves to the built
 * `dist/*.d.ts` the way it does in an app. Core's own source assigns `{}` to
 * `AmbientDeps` in places, so it cannot compile under an augmentation, and an
 * app never compiles it. The check therefore needs a prior `pnpm build`, as the
 * satellites' typechecks do. Like `type-pitfalls.test-d.ts`, it is checked by
 * `tsc --noEmit` and never executed.
 */

import { createRoot, defineController } from '@kontsedal/olas-core'
import { createTestController } from '@kontsedal/olas-core/testing'
import { describe, expectTypeOf, test } from 'vitest'

type ApiClient = { load(): Promise<string> }

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: ApiClient
    logger?: (message: string) => void
  }
}

const api: ApiClient = { load: async () => 'ok' }
const app = defineController((ctx) => ({ load: () => ctx.deps.api.load() }))

describe('createRoot checks deps against AmbientDeps', () => {
  test('a root that leaves out a required service does not compile', () => {
    // @ts-expect-error `api` is required by the augmented AmbientDeps
    createRoot(app, { deps: {} })
  })

  test('a service of the wrong type does not compile', () => {
    // @ts-expect-error `api` must be an ApiClient
    createRoot(app, { deps: { api: 42 } })
  })

  test('a deps object built before the call is checked the same way', () => {
    const deps = { logger: (message: string) => void message }
    // @ts-expect-error `api` is missing from the prebuilt object
    createRoot(app, { deps })
  })

  test('the required services compile, and an optional one may be left out', () => {
    createRoot(app, { deps: { api } })
  })

  test('a root that passes more than AmbientDeps requires still compiles', () => {
    createRoot(app, { deps: { api, logger: () => {}, clock: () => 0 } })
  })

  test('ctx.deps is typed from the augmentation', () => {
    defineController((ctx) => {
      expectTypeOf(ctx.deps.api).toEqualTypeOf<ApiClient>()
      return {}
    })
  })
})

describe('createTestController does not check deps', () => {
  test('a test passes only the fakes the controller under test reads', () => {
    createTestController(app, { deps: {} })
  })
})
