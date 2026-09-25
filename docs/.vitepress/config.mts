import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitepress'

// Reference pages come from api-documenter (`pnpm docs:sync`): one page per
// package, named `olas-<package>.md`, plus one per exported member.
const referenceDir = join(import.meta.dirname, '..', 'reference')
const referencePackages = (() => {
  try {
    return readdirSync(referenceDir)
      .filter((f) => /^olas-[a-z-]+\.md$/.test(f))
      .map((f) => f.slice(0, -3))
      .sort((a, b) => (a === 'olas-core' ? -1 : b === 'olas-core' ? 1 : a.localeCompare(b)))
  } catch {
    return []
  }
})()

export default defineConfig({
  title: 'Olas',
  description:
    'Controllers, queries, mutations and forms with explicit lifetimes, on signals. Logic that runs and tests without a renderer.',
  // GitHub Pages serves the project site under /olas/.
  base: '/olas/',
  cleanUrls: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/olas/favicon.svg' }]],
  lastUpdated: false,
  srcExclude: ['**/README.md'],
  // The generated reference links to members by file name; every one exists.
  // A dead link anywhere else is a real error.
  ignoreDeadLinks: [/^\.\/olas-[a-z0-9_.-]+$/],
  markdown: {
    // The synced READMEs use raw HTML tables and `<details>`.
    html: true,
    config(md) {
      // Vue compiles every page as a template, so `{{ … }}` in inline code
      // (JSX props such as `options={{ deps }}`) would be read as an
      // interpolation. Fenced blocks are already `v-pre`; inline code gets
      // the same treatment.
      const inline = md.renderer.rules.code_inline
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        if (token !== undefined) token.attrSet('v-pre', '')
        return inline === undefined
          ? self.renderToken(tokens, idx, options)
          : inline(tokens, idx, options, env, self)
      }
    },
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Adapters', link: '/adapters/react' },
      { text: 'Packages', link: '/packages/core' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Migrating to 1.0', link: '/guide/migration' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Concepts', link: '/guide/concepts' },
            { text: 'Queries', link: '/guide/queries' },
            { text: 'Mutations', link: '/guide/mutations' },
            { text: 'Forms', link: '/guide/forms' },
            { text: 'Plugins', link: '/guide/plugins' },
            { text: 'SSR', link: '/guide/ssr' },
            { text: 'Testing', link: '/guide/testing' },
            { text: 'Recipes', link: '/guide/recipes' },
            { text: 'Performance', link: '/guide/performance' },
            { text: 'Migrating to 1.0', link: '/guide/migration' },
          ],
        },
      ],
      '/adapters/': [
        {
          text: 'Adapters',
          items: [
            { text: 'React (and Preact)', link: '/adapters/react' },
            { text: 'Vue', link: '/adapters/vue' },
            { text: 'Svelte', link: '/adapters/svelte' },
          ],
        },
      ],
      '/packages/': [
        {
          text: 'Packages',
          items: [
            { text: 'core', link: '/packages/core' },
            { text: 'persist', link: '/packages/persist' },
            { text: 'zod', link: '/packages/zod' },
            { text: 'cross-tab', link: '/packages/cross-tab' },
            { text: 'entities', link: '/packages/entities' },
            { text: 'realtime', link: '/packages/realtime' },
            { text: 'mutation-queue', link: '/packages/mutation-queue' },
            { text: 'router', link: '/packages/router' },
            { text: 'devtools', link: '/packages/devtools' },
            { text: 'eslint-plugin', link: '/packages/eslint-plugin' },
            { text: 'codemod', link: '/packages/codemod' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API reference',
          items: [
            { text: 'All packages', link: '/reference/' },
            ...referencePackages.map((name) => ({
              text: `@kontsedal/${name}`,
              link: `/reference/${name}`,
            })),
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/Kontsedal/olas' }],
    editLink: {
      pattern: 'https://github.com/Kontsedal/olas/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    outline: [2, 3],
  },
})
