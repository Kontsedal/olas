import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { olasAliases, olasDefine } from '../_shared/aliases.ts'

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  resolve: { alias: olasAliases },
  define: olasDefine(mode),
  server: { port: 5184 },
}))
