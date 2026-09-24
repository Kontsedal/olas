import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

const satellite = { statements: 94, branches: 90, functions: 94, lines: 96 }

// Svelte component tests need two things no other suite should get: the
// compiler plugin, and the `browser` resolve condition, without which `svelte`
// resolves to its server build and `mount` throws. They run as their own
// project; everything else keeps the default resolution.
const SVELTE_TESTS = [
  'packages/svelte/tests/**/*.test.ts',
  'packages/integration/tests/adapter-parity/svelte.test.ts',
]

export default defineConfig({
  define: {
    __DEV__: 'true',
  },
  resolve: {
    alias: {
      '@kontsedal/olas-core/testing': resolve(__dirname, 'packages/core/src/testing.ts'),
      '@kontsedal/olas-core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@kontsedal/olas-react': resolve(__dirname, 'packages/react/src/index.ts'),
      '@kontsedal/olas-vue': resolve(__dirname, 'packages/vue/src/index.ts'),
      '@kontsedal/olas-svelte': resolve(__dirname, 'packages/svelte/src/index.ts'),
      '@kontsedal/olas-persist': resolve(__dirname, 'packages/persist/src/index.ts'),
      '@kontsedal/olas-realtime': resolve(__dirname, 'packages/realtime/src/index.ts'),
      '@kontsedal/olas-cross-tab': resolve(__dirname, 'packages/cross-tab/src/index.ts'),
      '@kontsedal/olas-entities': resolve(__dirname, 'packages/entities/src/index.ts'),
      '@kontsedal/olas-zod': resolve(__dirname, 'packages/zod/src/index.ts'),
      '@kontsedal/olas-devtools': resolve(__dirname, 'packages/devtools/src/index.ts'),
      '@kontsedal/olas-mutation-queue': resolve(__dirname, 'packages/mutation-queue/src/index.ts'),
      '@kontsedal/olas-router': resolve(__dirname, 'packages/router/src/index.ts'),
      '@kontsedal/olas-eslint-plugin': resolve(__dirname, 'packages/eslint-plugin/src/index.ts'),
    },
  },
  test: {
    // Mocha-style: Devtools tests target jsdom, set per-file via @vitest-environment.
    environment: 'node',
    globals: false,
    pool: 'forks',
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
          include: ['packages/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.tsx'],
          exclude: SVELTE_TESTS,
        },
      },
      {
        extends: true,
        plugins: [svelte()],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'svelte',
          include: SVELTE_TESTS,
          environment: 'jsdom',
          // Benchmarks run once, in the default project.
          benchmark: { include: [] },
        },
      },
    ],
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
        'packages/codemod/src/**': satellite,
        'packages/cross-tab/src/**': satellite,
        'packages/devtools/src/**': satellite,
        'packages/entities/src/**': satellite,
        'packages/eslint-plugin/src/**': satellite,
        'packages/mutation-queue/src/**': satellite,
        'packages/persist/src/**': satellite,
        'packages/react/src/**': satellite,
        'packages/realtime/src/**': satellite,
        'packages/router/src/**': satellite,
        'packages/svelte/src/**': satellite,
        'packages/vue/src/**': satellite,
        'packages/zod/src/**': satellite,
      },
    },
  },
})
