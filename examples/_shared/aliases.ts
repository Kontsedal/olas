// Vite + Vitest source aliases for example apps.
//
// Each example sits one workspace down from the repo root. `@olas/*` packages
// resolve to `dist/` via their `package.json`, but dist isn't built unless the
// user ran `pnpm build` first. The aliases below point Vite directly at source
// so examples run with zero pre-build. Mirrors the root `vitest.config.ts`.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

export const olasAliases: Record<string, string> = {
  '@olas/core/testing': resolve(repoRoot, 'packages/core/src/testing.ts'),
  '@olas/core':         resolve(repoRoot, 'packages/core/src/index.ts'),
  '@olas/react':        resolve(repoRoot, 'packages/react/src/index.ts'),
  '@olas/zod':          resolve(repoRoot, 'packages/zod/src/index.ts'),
  '@olas/persist':      resolve(repoRoot, 'packages/persist/src/index.ts'),
  '@olas/devtools':     resolve(repoRoot, 'packages/devtools/src/index.ts'),
}
