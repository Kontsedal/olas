import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { olasAliases } from '../_shared/aliases'

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: olasAliases },
  server: { port: 5180 },
})
