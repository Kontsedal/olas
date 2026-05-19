import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

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
      '@kontsedal/olas-zod': resolve(__dirname, 'packages/zod/src/index.ts'),
      '@kontsedal/olas-devtools': resolve(__dirname, 'packages/devtools/src/index.ts'),
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
