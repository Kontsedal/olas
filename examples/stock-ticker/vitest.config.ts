import { defineConfig } from 'vitest/config'
import { olasAliases } from '../_shared/aliases'

export default defineConfig({
  resolve: { alias: olasAliases },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
