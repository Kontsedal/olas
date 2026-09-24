import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const satellite = { statements: 94, branches: 90, functions: 94, lines: 96 }

export default defineConfig({
  define: {
    __DEV__: 'true',
  },
  resolve: {
    alias: {
      '@kontsedal/olas-core/testing': resolve(__dirname, 'packages/core/src/testing.ts'),
      '@kontsedal/olas-core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@kontsedal/olas-react': resolve(__dirname, 'packages/react/src/index.ts'),
      '@kontsedal/olas-persist': resolve(__dirname, 'packages/persist/src/index.ts'),
      '@kontsedal/olas-realtime': resolve(__dirname, 'packages/realtime/src/index.ts'),
      '@kontsedal/olas-cross-tab': resolve(__dirname, 'packages/cross-tab/src/index.ts'),
      '@kontsedal/olas-entities': resolve(__dirname, 'packages/entities/src/index.ts'),
      '@kontsedal/olas-zod': resolve(__dirname, 'packages/zod/src/index.ts'),
      '@kontsedal/olas-devtools': resolve(__dirname, 'packages/devtools/src/index.ts'),
      '@kontsedal/olas-mutation-queue': resolve(__dirname, 'packages/mutation-queue/src/index.ts'),
      '@kontsedal/olas-router': resolve(__dirname, 'packages/router/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.tsx'],
    // Mocha-style: Devtools tests target jsdom, set per-file via @vitest-environment.
    environment: 'node',
    globals: false,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.d.ts'],
      // Gates, set a little below the levels the 1.0 coverage pass reached
      // (2026-09-25: core 99.4 lines / 94.9 branches; every satellite >= 99
      // lines, >= 90 branches), so CI fails on a real regression without
      // flaking on measurement jitter. Raise them as coverage improves; never
      // lower them to make a red build pass. What is left uncovered is listed,
      // with a reason per branch, in `.wiki/decisions/engine-assurance.md`.
      thresholds: {
        statements: 96,
        branches: 92,
        functions: 96,
        lines: 97,
        'packages/core/src/**': { statements: 96, branches: 92, functions: 96, lines: 97 },
        // One gate per satellite, so a package cannot slip while others carry it.
        'packages/cross-tab/src/**': satellite,
        'packages/devtools/src/**': satellite,
        'packages/entities/src/**': satellite,
        'packages/mutation-queue/src/**': satellite,
        'packages/persist/src/**': satellite,
        'packages/react/src/**': satellite,
        'packages/realtime/src/**': satellite,
        'packages/router/src/**': satellite,
        'packages/zod/src/**': satellite,
      },
    },
  },
})
