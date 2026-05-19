import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { olasAliases, olasDefine } from '../_shared/aliases'

export default defineConfig(({ mode }) => ({
  plugins: [tailwindcss()],
  resolve: { alias: olasAliases },
  define: olasDefine(mode),
  server: { port: 5180 },
}))
