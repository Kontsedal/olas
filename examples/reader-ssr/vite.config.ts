import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { olasAliases } from '../_shared/aliases'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: olasAliases },
  server: { port: 5182 },
  ssr: {
    noExternal: ['@olas/core', '@olas/react', '@olas/persist'],
  },
})
