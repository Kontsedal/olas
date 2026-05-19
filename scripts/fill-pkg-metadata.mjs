#!/usr/bin/env node
// One-shot enrichment of @kontsedal/olas-* package.json files with author,
// repository, homepage, bugs, and keywords. Idempotent — re-running on an
// already-enriched manifest is a no-op (existing values are preserved unless
// they match the legacy defaults we want to overwrite).
//
// Run with: node scripts/fill-pkg-metadata.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const AUTHOR = 'Bohdan Kontsedal <kontsedalbohdan@gmail.com>'
const REPO_URL = 'git+https://github.com/Kontsedal/olas.git'
const ISSUES_URL = 'https://github.com/Kontsedal/olas/issues'
const COMMON_KEYWORDS = ['olas', 'controller-tree', 'signals', 'reactive', 'state-management']

const PER_PACKAGE = {
  core: {
    description: 'Olas core — controller-tree state management with signals, queries, mutations, and forms. Framework-agnostic.',
    keywords: [
      ...COMMON_KEYWORDS,
      'query-cache',
      'mutation',
      'optimistic-updates',
      'forms',
      'ssr',
      'framework-agnostic',
    ],
  },
  react: {
    description: 'Olas React adapter — OlasProvider, useRoot, useQuery, useField, KeepAlive, useSuspendOnHidden.',
    keywords: [...COMMON_KEYWORDS, 'react', 'hooks', 'keep-alive', 'concurrent-react'],
  },
  zod: {
    description: 'Olas Zod integration — zodValidator and formFromZod for end-to-end typed forms.',
    keywords: [...COMMON_KEYWORDS, 'zod', 'validation', 'forms'],
  },
  persist: {
    description: 'Olas persistence composables — usePersisted with a localStorage adapter.',
    keywords: [...COMMON_KEYWORDS, 'persistence', 'localStorage', 'cache-persistence'],
  },
  devtools: {
    description: 'Olas in-app devtools — controller tree inspector, cache timeline, mutation log, signal graph.',
    keywords: [...COMMON_KEYWORDS, 'devtools', 'debugging', 'inspector'],
  },
  realtime: {
    description: 'Olas realtime composables — useRealtimePatcher and defineLiveStream over a pluggable RealtimeService.',
    keywords: [...COMMON_KEYWORDS, 'realtime', 'websocket', 'sse', 'cache-patching'],
  },
  'cross-tab': {
    description: 'Olas cross-tab cache sync — BroadcastChannel-backed QueryClientPlugin keeping every browser tab in lockstep.',
    keywords: [...COMMON_KEYWORDS, 'broadcast-channel', 'cross-tab', 'cache-sync'],
  },
}

const ORDER = [
  'name',
  'version',
  'description',
  'keywords',
  'license',
  'author',
  'homepage',
  'repository',
  'bugs',
  'type',
  'main',
  'module',
  'types',
  'exports',
  'files',
  'sideEffects',
  'scripts',
  'peerDependencies',
  'dependencies',
  'devDependencies',
]

const reorder = (obj) => {
  const sorted = {}
  for (const key of ORDER) {
    if (key in obj) sorted[key] = obj[key]
  }
  for (const key of Object.keys(obj)) {
    if (!(key in sorted)) sorted[key] = obj[key]
  }
  return sorted
}

for (const [shortName, extras] of Object.entries(PER_PACKAGE)) {
  const path = resolve(repoRoot, 'packages', shortName, 'package.json')
  const raw = readFileSync(path, 'utf8')
  const pkg = JSON.parse(raw)

  pkg.description = extras.description
  pkg.keywords = extras.keywords
  pkg.author = AUTHOR
  pkg.homepage = `https://github.com/Kontsedal/olas/tree/main/packages/${shortName}#readme`
  pkg.repository = {
    type: 'git',
    url: REPO_URL,
    directory: `packages/${shortName}`,
  }
  pkg.bugs = { url: ISSUES_URL }
  pkg.publishConfig = pkg.publishConfig ?? { access: 'public' }

  const ordered = reorder(pkg)
  writeFileSync(path, JSON.stringify(ordered, null, 2) + '\n', 'utf8')
  console.log(`patched packages/${shortName}/package.json`)
}
