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

const GITHUB = 'https://github.com/Kontsedal/olas'

const guideSidebar = [
  {
    text: 'Introduction',
    items: [
      { text: 'What is Olas?', link: '/guide/what-is-olas' },
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'Concepts', link: '/guide/concepts' },
    ],
  },
  {
    text: 'Essentials',
    items: [
      { text: 'Queries', link: '/guide/queries' },
      { text: 'Mutations', link: '/guide/mutations' },
      { text: 'Forms', link: '/guide/forms' },
      { text: 'Testing', link: '/guide/testing' },
    ],
  },
  {
    text: 'Your framework',
    items: [
      { text: 'React and Preact', link: '/adapters/react' },
      { text: 'Vue', link: '/adapters/vue' },
      { text: 'Svelte', link: '/adapters/svelte' },
    ],
  },
  {
    text: 'Going further',
    items: [
      { text: 'Server rendering', link: '/guide/ssr' },
      { text: 'Plugins', link: '/guide/plugins' },
      { text: 'Performance', link: '/guide/performance' },
      { text: 'Recipes', link: '/guide/recipes' },
    ],
  },
  {
    text: 'Upgrading',
    items: [{ text: 'Migrating from 0.8', link: '/guide/migration' }],
  },
]

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
    logo: { light: '/favicon.svg', dark: '/logo-dark.svg', alt: '' },
    nav: [
      { text: 'Guide', link: '/guide/what-is-olas', activeMatch: '^/(guide|adapters)/' },
      { text: 'Packages', link: '/packages/core', activeMatch: '^/packages/' },
      { text: 'API', link: '/reference/', activeMatch: '^/reference/' },
      {
        text: '1.0',
        items: [
          { text: 'Migrating from 0.8', link: '/guide/migration' },
          { text: 'Example apps', link: `${GITHUB}/tree/main/examples` },
          { text: 'Specification', link: `${GITHUB}/blob/main/SPEC.md` },
          { text: 'Changelog', link: `${GITHUB}/blob/main/packages/core/CHANGELOG.md` },
        ],
      },
    ],
    sidebar: {
      // The guide and the adapter pages share one sidebar, ordered the way a
      // new reader meets the library: what it is, the core primitives, their
      // framework, then the rest.
      '/guide/': guideSidebar,
      '/adapters/': guideSidebar,
      '/packages/': [
        {
          text: 'Core',
          items: [{ text: 'olas-core', link: '/packages/core' }],
        },
        {
          text: 'Data and sync',
          items: [
            { text: 'Persistence', link: '/packages/persist' },
            { text: 'Cross-tab sync', link: '/packages/cross-tab' },
            { text: 'Entities', link: '/packages/entities' },
            { text: 'Realtime', link: '/packages/realtime' },
            { text: 'Mutation queue', link: '/packages/mutation-queue' },
          ],
        },
        {
          text: 'Routing and forms',
          items: [
            { text: 'Router', link: '/packages/router' },
            { text: 'Zod', link: '/packages/zod' },
          ],
        },
        {
          text: 'Tools',
          items: [
            { text: 'Devtools', link: '/packages/devtools' },
            { text: 'ESLint plugin', link: '/packages/eslint-plugin' },
            { text: 'Codemod', link: '/packages/codemod' },
          ],
        },
        {
          text: 'Frameworks',
          items: [
            { text: 'React and Preact', link: '/adapters/react' },
            { text: 'Vue', link: '/adapters/vue' },
            { text: 'Svelte', link: '/adapters/svelte' },
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
    socialLinks: [{ icon: 'github', link: GITHUB }],
    editLink: {
      pattern: `${GITHUB}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    footer: { message: 'Released under the MIT License.' },
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
  },
})
