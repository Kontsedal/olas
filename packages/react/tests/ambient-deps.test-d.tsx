/**
 * Type-level pin: `HydrationBoundary`'s `options.deps` is checked against
 * `AmbientDeps`, as `createRoot`'s are (SPEC §20.3).
 *
 * This file augments `AmbientDeps`, and an augmentation reaches every file in
 * its TypeScript program. So it compiles in a program of its own,
 * `tsconfig.ambient-deps.json`, which react's `typecheck` script runs after
 * the main one, as core's does. It imports the packages by name, so it reads
 * the built declarations and needs a prior `pnpm build`.
 */

import { defineController } from '@kontsedal/olas-core'
import { HydrationBoundary } from '@kontsedal/olas-react'
import { describe, test } from 'vitest'

type ApiClient = { load(): Promise<string> }

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: ApiClient
  }
}

const api: ApiClient = { load: async () => 'ok' }
const app = defineController((ctx) => ({ load: () => ctx.deps.api.load() }))

describe('HydrationBoundary checks deps against AmbientDeps', () => {
  test('options that leave out a required service do not compile', () => {
    // @ts-expect-error `api` is required by the augmented AmbientDeps
    ;<HydrationBoundary def={app} options={{ deps: {} }}>
      {null}
    </HydrationBoundary>
  })

  test('options with the required services compile', () => {
    ;<HydrationBoundary def={app} options={{ deps: { api } }}>
      {null}
    </HydrationBoundary>
  })
})
