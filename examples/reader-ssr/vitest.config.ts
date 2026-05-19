import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { olasAliases } from '../_shared/aliases'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: olasAliases },
  // Mirror root vitest.config.ts — @kontsedal/olas-core source has `if (__DEV__)` guards
  // that need substitution. Tests always run in dev mode.
  define: { __DEV__: 'true' },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
