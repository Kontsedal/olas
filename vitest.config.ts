import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@olas/core/testing': resolve(__dirname, 'packages/core/src/testing.ts'),
      '@olas/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@olas/react': resolve(__dirname, 'packages/react/src/index.ts'),
      '@olas/persist': resolve(__dirname, 'packages/persist/src/index.ts'),
      '@olas/zod': resolve(__dirname, 'packages/zod/src/index.ts'),
      '@olas/devtools': resolve(__dirname, 'packages/devtools/src/index.ts'),
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
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/index.ts'],
    },
  },
})
