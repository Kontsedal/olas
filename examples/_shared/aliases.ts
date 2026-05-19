// Vite + Vitest source aliases for example apps.
//
// Each example sits one workspace down from the repo root. `@kontsedal/olas-*` packages
// resolve to `dist/` via their `package.json`, but dist isn't built unless the
// user ran `pnpm build` first. The aliases below point Vite directly at source
// so examples run with zero pre-build. Mirrors the root `vitest.config.ts`.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

export const olasAliases: Record<string, string> = {
  '@kontsedal/olas-core/testing': resolve(repoRoot, 'packages/core/src/testing.ts'),
  '@kontsedal/olas-core': resolve(repoRoot, 'packages/core/src/index.ts'),
  '@kontsedal/olas-react': resolve(repoRoot, 'packages/react/src/index.ts'),
  '@kontsedal/olas-zod': resolve(repoRoot, 'packages/zod/src/index.ts'),
  '@kontsedal/olas-persist': resolve(repoRoot, 'packages/persist/src/index.ts'),
  '@kontsedal/olas-devtools': resolve(repoRoot, 'packages/devtools/src/index.ts'),
  '@kontsedal/olas-realtime': resolve(repoRoot, 'packages/realtime/src/index.ts'),
  '@kontsedal/olas-cross-tab': resolve(repoRoot, 'packages/cross-tab/src/index.ts'),
}

/**
 * Vite `define` block needed by example apps. `@kontsedal/olas-core` source has
 * `if (__DEV__) { … }` guards (see commit d39708a) that tsdown substitutes
 * at build time. The examples consume source via `olasAliases`, so they
 * must substitute `__DEV__` themselves or the controller construction path
 * throws `ReferenceError: __DEV__ is not defined` at runtime.
 *
 * Mirrors `vitest.config.ts`'s `define`. `vite dev` → 'true', `vite build` → 'false'.
 */
export const olasDefine = (mode: string): Record<string, string> => ({
  __DEV__: mode === 'production' ? 'false' : 'true',
})
