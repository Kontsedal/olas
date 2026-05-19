import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { olasAliases, olasDefine } from '../_shared/aliases'

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: olasAliases },
  define: olasDefine(mode),
  server: { port: 5182 },
  ssr: {
    noExternal: ['@kontsedal/olas-core', '@kontsedal/olas-react', '@kontsedal/olas-persist'],
  },
}))
