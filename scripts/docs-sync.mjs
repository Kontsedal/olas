/**
 * Build the docs site's generated pages from the repo's own docs, so the site
 * and the snippet-checked Markdown share one source.
 *
 * - Synced pages: RECIPES, PLUGINS, MIGRATING and every package README are
 *   copied under `docs/`. Relative links are rewritten: to the page's site
 *   route when the target is another synced doc, otherwise to the file on
 *   GitHub.
 * - The API reference: `api-documenter` turns the doc model that
 *   `pnpm api:update` / `api:check` writes (`temp/api-model/`) into
 *   `docs/reference/`.
 *
 * Every generated file is gitignored. Run `pnpm build && pnpm api:check`
 * first, or use `pnpm docs:build`, which runs the chain.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')
const GITHUB = 'https://github.com/Kontsedal/olas'

/** Repo file → site page (a path under docs/, without `.md`). */
const synced = new Map([
  ['RECIPES.md', 'guide/recipes'],
  ['PLUGINS.md', 'guide/plugins'],
  ['MIGRATING.md', 'guide/migration'],
  ['packages/react/README.md', 'adapters/react'],
  ['packages/vue/README.md', 'adapters/vue'],
  ['packages/svelte/README.md', 'adapters/svelte'],
])
for (const dir of readdirSync(join(root, 'packages'))) {
  const readme = `packages/${dir}/README.md`
  const pkg = join(root, 'packages', dir, 'package.json')
  if (!existsSync(join(root, readme)) || !existsSync(pkg)) continue
  if (JSON.parse(readFileSync(pkg, 'utf8')).private) continue
  if (!synced.has(readme)) synced.set(readme, `packages/${dir}`)
}

/** The site route for a repo path, if that path is a synced doc. */
const routeFor = (repoPath) => synced.get(repoPath)

function rewriteLink(target, sourceRepoPath, pagePath) {
  if (/^[a-z]+:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return target
  const [path, hash] = target.split('#')
  const repoPath = posix.normalize(posix.join(posix.dirname(sourceRepoPath), path))
  const anchor = hash === undefined ? '' : `#${hash}`
  const route = routeFor(repoPath)
  if (route !== undefined) {
    const rel = posix.relative(posix.dirname(pagePath), route)
    return `${rel.startsWith('.') ? rel : `./${rel}`}${anchor}`
  }
  if (repoPath.startsWith('..')) return target
  const abs = join(root, repoPath)
  const kind = existsSync(abs) && !repoPath.includes('.') ? 'tree' : 'blob'
  return `${GITHUB}/${kind}/main/${repoPath}${anchor}`
}

function sync(sourceRepoPath, pagePath) {
  let text = readFileSync(join(root, sourceRepoPath), 'utf8').replace(/\r\n/g, '\n')
  const fences = []
  // Leave code blocks alone: a link-shaped string in code is code.
  text = text.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[^\S\n]*$/gm, (block) => {
    fences.push(block)
    return `@@OLAS_DOCS_SYNC_FENCE_${fences.length - 1}@@`
  })
  text = text.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (_m, target, title = '') => {
    return `](${rewriteLink(target, sourceRepoPath, pagePath)}${title})`
  })
  text = text.replace(
    /href="([^"]+)"/g,
    (_m, target) => `href="${rewriteLink(target, sourceRepoPath, pagePath)}"`,
  )
  text = text.replace(/@@OLAS_DOCS_SYNC_FENCE_(\d+)@@/g, (_m, i) => fences[Number(i)])
  const edit = `${GITHUB}/edit/main/${sourceRepoPath}`
  const out = join(docs, `${pagePath}.md`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(
    out,
    `---\neditLink: false\n---\n\n<!-- Generated from ${sourceRepoPath} by scripts/docs-sync.mjs. Edit that file: ${edit} -->\n\n${text}`,
  )
}

for (const [source, page] of synced) sync(source, page)

// The API reference, from api-extractor's doc model.
const model = join(root, 'temp', 'api-model')
const reference = join(docs, 'reference')
if (!existsSync(model) || readdirSync(model).length === 0) {
  console.error('[docs-sync] temp/api-model is empty. Run `pnpm build && pnpm api:check` first.')
  process.exit(1)
}
rmSync(reference, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/@microsoft/api-documenter/bin/api-documenter'),
    'markdown',
    '-i',
    model,
    '-o',
    reference,
  ],
  { stdio: 'ignore' },
)
for (const file of readdirSync(reference)) {
  if (file === 'index.md') continue
  const path = join(reference, file)
  let text = readFileSync(path, 'utf8')
  if (text.startsWith('---')) continue
  // api-documenter opens each page with an H2 ("createQuery() function").
  // As the H1, it gives VitePress the tab title and the page the guide's
  // title style.
  text = text.replace(/^## (.+)$/m, '# $1')
  // The first crumb is the reference index, not the site's home page.
  text = text.replace('[Home](./index.md)', '[API reference](./index.md)')
  // `api-page` lets the theme style the breadcrumb line above the title.
  writeFileSync(path, `---\npageClass: api-page\neditLink: false\n---\n\n${text}`)
}

// api-documenter's own index lists the packages under an empty description
// column, because no package has a TSDoc package comment. The index is
// written from each package.json instead, so npm and the site describe a
// package in the same words.
const isCore = (pkg) => pkg.name.endsWith('/olas-core')
const referencePackages = readdirSync(join(root, 'packages'))
  .map((dir) => join(root, 'packages', dir, 'package.json'))
  .filter((pkg) => existsSync(pkg))
  .map((pkg) => JSON.parse(readFileSync(pkg, 'utf8')))
  .filter((pkg) => !pkg.private && existsSync(join(reference, `${pkg.name.split('/')[1]}.md`)))
  // Core first, then the rest by name.
  .sort((a, b) => Number(isCore(b)) - Number(isCore(a)) || a.name.localeCompare(b.name))
writeFileSync(
  join(reference, 'index.md'),
  [
    '---',
    'title: API reference',
    'pageClass: api-index',
    'editLink: false',
    '---',
    '',
    '# API reference',
    '',
    'Every export of every package, with its exact signature. These pages are generated from the published type declarations, so they match what your editor shows.',
    '',
    `For examples, gotchas and the reasoning behind each API, read the guide or [API.md](${GITHUB}/blob/main/API.md).`,
    '',
    '| Package | What it is |',
    '|---|---|',
    ...referencePackages.map(
      (pkg) => `| [${pkg.name}](./${pkg.name.split('/')[1]}) | ${pkg.description ?? ''} |`,
    ),
    '',
  ].join('\n'),
)
console.log(
  `[docs-sync] ${synced.size} synced pages, ${readdirSync(reference).length} reference pages (${relative(root, reference)})`,
)
