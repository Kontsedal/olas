import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { olasAliases } from '../_shared/aliases'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: olasAliases },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
