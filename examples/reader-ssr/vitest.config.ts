import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
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
