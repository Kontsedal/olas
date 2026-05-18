import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { olasAliases } from '../_shared/aliases'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: olasAliases },
  server: { port: 5181 },
})
