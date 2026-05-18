import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { olasAliases } from '../_shared/aliases'

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: olasAliases },
  server: { port: 5180 },
})
