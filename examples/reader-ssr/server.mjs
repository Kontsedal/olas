// Tiny production SSR server. Run after `pnpm build`:
//
//   node server.mjs       # serves on port 5183
//
// Reads the prebuilt client HTML template and SSR bundle, calls the bundle's
// `render(url)` per request, splices the rendered HTML + serialized state
// into the template, and ships it.
//
// This skips the Vite dev-mode middleware to keep the example small. Use
// `pnpm dev` for the regular SPA dev server (no SSR) during development.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT ?? 5183

const clientHtml = await readFile(resolve(__dirname, 'dist/client/index.html'), 'utf8')
const { render } = await import(resolve(__dirname, 'dist/server/entry-server.js'))

const app = express()
app.use('/assets', express.static(resolve(__dirname, 'dist/client/assets')))
app.use('*', async (req, res) => {
  try {
    const { html, state } = await render(req.originalUrl)
    const out = clientHtml
      .replace('<!--app-html-->', html)
      .replace(/\/\*--olas-state--\*\/null\/\*--olas-state--\*\//, JSON.stringify(state))
    res.set('Content-Type', 'text/html').end(out)
  } catch (err) {
    console.error('SSR error:', err)
    res.status(500).end('Internal error')
  }
})
app.listen(PORT, () => {
  console.log(`SSR reader on http://localhost:${PORT}`)
})
