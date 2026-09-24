/**
 * Typecheck the TypeScript code blocks in the user-facing docs against the
 * current sources, so a doc example that would not compile fails CI instead
 * of a reader.
 *
 * Every ```ts / ```tsx / ```typescript block in the files below becomes its
 * own module, and one TypeScript program per doc checks them, so each doc
 * reads as one app with its own `AmbientDeps` and `Register` augmentations.
 * `@kontsedal/olas-*` imports resolve to the package sources. Third-party
 * imports resolve through the workspace's installed dependencies.
 *
 * Three annotations, all invisible when the Markdown renders:
 * - `<!-- snippet-prelude … -->` on the lines right before a block adds code
 *   that compiles with the block but is not shown, such as
 *   `declare const api: …` for a variable the reader does not need to see
 *   defined.
 * - `file=name.ts` in the info string (```ts file=counter.ts) names the
 *   block's module, so a later block in the same doc can import it as
 *   `./counter`. A relative import that no block defines is the reader's own
 *   file, such as `./App`, and resolves to `any`.
 * - `nocheck` in the info string (```ts nocheck) skips the block. Use it for
 *   signature listings, 0.8 "before" code and deliberate pseudo-code.
 *
 * Usage: `pnpm check:doc-snippets [--keep] [file.md ...]`. Each run writes its
 * modules to its own `.doc-snippets/<pid>/` and deletes them at exit.
 * `--keep` leaves them for inspection.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Per process, so two runs at once do not delete each other's modules.
const outDir = join(root, '.doc-snippets', String(process.pid))
const packagesDir = join(root, 'packages')

const DOCS = ['README.md', 'API.md', 'RECIPES.md', 'PLUGINS.md', 'MIGRATING.md']
const readmes = (dir: string) =>
  readdirSync(join(root, dir))
    .map((name) => `${dir}/${name}/README.md`)
    .filter((p) => existsSync(join(root, p)))
// The docs site's hand-written pages. `scripts/docs-sync.mjs` generates the
// rest from the files above, so checking those again would add nothing.
const sitePages = (dir: string): string[] =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir))
        .filter((f) => f.endsWith('.md'))
        .map((f) => `${dir}/${f}`)
        .filter((p) => !readFileSync(join(root, p), 'utf8').includes('by scripts/docs-sync.mjs'))
    : []

type Snippet = {
  source: string
  /** 1-based line in `source` of the block's first code line. */
  line: number
  lang: 'ts' | 'tsx'
  file: string | undefined
  code: string
  preludeLines: number
}

const FENCE = /^(\s*)```(ts|tsx|typescript)\b([^\n]*)$/
const PRELUDE_OPEN = /^\s*<!--\s*snippet-prelude\s*$/

function extract(source: string): Snippet[] {
  const lines = readFileSync(join(root, source), 'utf8').replace(/\r\n/g, '\n').split('\n')
  const out: Snippet[] = []
  let prelude: string[] | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (PRELUDE_OPEN.test(line)) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] as string).includes('-->'))
        body.push(lines[i++] as string)
      prelude = body
      i += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence === null) {
      if (line.trim() !== '') prelude = null
      i += 1
      continue
    }
    const indent = fence[1] as string
    const info = fence[3] as string
    const lang = fence[2] === 'tsx' ? 'tsx' : 'ts'
    const file = /\bfile=(\S+)/.exec(info)?.[1]
    const start = i + 2
    const body: string[] = []
    i += 1
    while (i < lines.length && !(lines[i] as string).trim().startsWith('```')) {
      const l = lines[i] as string
      body.push(l.startsWith(indent) ? l.slice(indent.length) : l)
      i += 1
    }
    i += 1
    if (!/\bnocheck\b/.test(info)) {
      const pre = prelude ?? []
      out.push({
        source,
        line: start,
        lang,
        file,
        code: [...pre, ...body].join('\n'),
        preludeLines: pre.length,
      })
    }
    prelude = null
  }
  return out
}

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const named = args.filter((a) => a !== '--keep')
const files =
  named.length > 0
    ? named
    : [
        ...DOCS,
        ...readmes('packages'),
        ...readmes('examples'),
        ...sitePages('docs'),
        ...sitePages('docs/guide'),
      ]
const snippets = files.flatMap(extract)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const byPath = new Map<string, Snippet>()
snippets.forEach((s, n) => {
  // One directory per doc, so `./counter` resolves only within its own doc.
  const dir = join(outDir, s.source.replace(/[\\/.]/g, '_'))
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, s.file ?? `_${String(n).padStart(3, '0')}.${s.lang}`)
  if (byPath.has(path)) throw new Error(`${s.source}:${s.line}: a second block named ${s.file}`)
  // `export {}` keeps each snippet its own module, so names cannot clash.
  writeFileSync(path, `${s.code}\nexport {}\n`)
  byPath.set(path, s)
})

// Modules a snippet imports that are not ours to check: the reader's own
// files, and third-party libraries the workspace does not install.
const ambient = join(outDir, '_ambient.d.ts')
writeFileSync(
  ambient,
  `interface ImportMetaEnv { readonly DEV: boolean; readonly PROD: boolean; readonly MODE: string }
interface ImportMeta { readonly env: ImportMetaEnv }
declare module '*.vue'
declare module '*.svelte'
declare module '@tanstack/react-router'
declare module 'react-router-dom'
`,
)

const paths: Record<string, string[]> = {
  '@kontsedal/olas-core/testing': [join(packagesDir, 'core/src/testing.ts')],
}
const packageDirs = readdirSync(packagesDir).filter((name) =>
  existsSync(join(packagesDir, name, 'package.json')),
)
for (const name of packageDirs) {
  const pkg = JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8')) as {
    name: string
    private?: boolean
  }
  const entry = join(packagesDir, name, 'src/index.ts')
  if (!pkg.private && existsSync(entry)) paths[pkg.name] = [entry]
}
// Third-party imports: each package's own dependencies, types first, then
// the root's (vitest and the build tools).
paths['*'] = [
  ...packageDirs.flatMap((name) => [
    join(packagesDir, name, 'node_modules/@types/*'),
    join(packagesDir, name, 'node_modules/*'),
  ]),
  join(root, 'node_modules/@types/*'),
  join(root, 'node_modules/*'),
]

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  isolatedModules: true,
  types: ['node'],
  typeRoots: [join(root, 'node_modules/@types')],
  paths,
}

// Every package entry is a root file. TypeScript adds a module to the program
// only when something imports it, and a `declare module` augmentation alone
// does not count, so a snippet that only augments `Register` would fail.
const entries = Object.entries(paths)
  .filter(([name]) => name !== '*')
  .map(([, [entry]]) => entry as string)

// One program per doc. A doc reads as one app, so its `AmbientDeps` or
// `Register` augmentation must not merge with another doc's. The host caches
// parsed files, so the package sources are parsed once for all the programs.
const baseHost = ts.createCompilerHost(options)
const parsed = new Map<string, ts.SourceFile | undefined>()
const host: ts.CompilerHost = {
  ...baseHost,
  getSourceFile(fileName, languageVersion, onError, shouldCreate) {
    const key = resolve(fileName)
    if (!byPath.has(key) && parsed.has(key)) return parsed.get(key)
    const sf = baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreate)
    parsed.set(key, sf)
    return sf
  },
}
const byDoc = new Map<string, string[]>()
for (const [path, s] of byPath) byDoc.set(s.source, [...(byDoc.get(s.source) ?? []), path])

const report = new Map<string, string[]>()
let total = 0
let oldProgram: ts.Program | undefined
for (const [source, docFiles] of byDoc) {
  const program = ts.createProgram({
    rootNames: [...docFiles, ambient, ...entries],
    options,
    host,
    oldProgram,
  })
  oldProgram = program
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    // Only the snippets: an error inside a package source is the package
    // typecheck's job, and skipping them keeps a run to a few seconds.
    ...docFiles.flatMap((f) => {
      const sf = program.getSourceFile(f)
      return sf === undefined
        ? []
        : [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
    }),
  ]
  for (const d of diagnostics) {
    const snippet = d.file === undefined ? undefined : byPath.get(resolve(d.file.fileName))
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0] as string
    // TS2307 on a relative specifier: the reader's own file, such as `./App`.
    if (d.code === 2307 && /module '\.\.?\//.test(message)) continue
    let where = source
    if (snippet !== undefined && d.file !== undefined) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0)
      where =
        line < snippet.preludeLines
          ? `${snippet.source}:${snippet.line} (prelude line ${line + 1})`
          : `${snippet.source}:${snippet.line + line - snippet.preludeLines}`
    } else if (d.file !== undefined) {
      where = `${source} (via ${relative(root, d.file.fileName)})`
    }
    const list = report.get(source) ?? []
    list.push(`  ${where}  ${message}`)
    report.set(source, list)
    total += 1
  }
}

for (const [source, list] of report) {
  console.log(`\n${source} (${list.length})`)
  for (const entry of list) console.log(entry)
}
if (!keep) rmSync(outDir, { recursive: true, force: true })
console.log(
  `\n[doc-snippets] ${snippets.length} snippets in ${files.length} files · ${total} error(s)` +
    (keep ? ` · generated modules in ${relative(root, outDir)}` : ''),
)
process.exit(total > 0 ? 1 : 0)
