import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Project, ts } from 'ts-morph'
import { type RunResult, runCodemod, selectFiles } from './run'

/** Where the CLI runs and writes its report. */
export type CliIO = {
  readonly cwd: string
  log(message: string): void
  error(message: string): void
}

export const USAGE = `Usage: olas-codemod 1.0 [--tsconfig <path>] [--dry] [paths...]

Rewrites an Olas 0.8 project for 1.0, in place.

  --tsconfig <path>  the project to load (default: ./tsconfig.json)
  --dry              report what would change, and write nothing
  paths              rewrite only the files under these paths

Run it on a clean git tree, while the 0.8 packages are still installed, and
review the diff. The TODO list names every site it could not rewrite.`

type Args = {
  target: string | undefined
  tsconfig: string | undefined
  dry: boolean
  help: boolean
  paths: string[]
  unknown: string | undefined
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    target: undefined,
    tsconfig: undefined,
    dry: false,
    help: false,
    paths: [],
    unknown: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--dry') args.dry = true
    else if (arg === '--tsconfig') {
      args.tsconfig = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--tsconfig=')) args.tsconfig = arg.slice('--tsconfig='.length)
    else if (arg.startsWith('-')) args.unknown ??= arg
    else if (args.target === undefined) args.target = arg
    else args.paths.push(arg)
  }
  return args
}

const SOURCES = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'

/** A path as the globs ts-morph adds files from: a directory's sources, or the file itself. */
function globsFor(path: string): string[] {
  const p = path.replaceAll('\\', '/')
  if (!statSync(path).isDirectory()) return [p]
  return [`${p}/${SOURCES}`, `!${p}/**/node_modules/**`]
}

type Loaded = { project: Project; rootDir: string }

function loadProject(args: Args, cwd: string): Loaded | string {
  const paths = args.paths.map((p) => resolve(cwd, p))
  const missing = paths.find((p) => !existsSync(p))
  if (missing !== undefined) return `No such path: ${missing}`
  const tsconfig = resolve(cwd, args.tsconfig ?? 'tsconfig.json')
  const globs = paths.flatMap(globsFor)
  if (existsSync(tsconfig)) {
    const project = new Project({ tsConfigFilePath: tsconfig })
    if (globs.length > 0) project.addSourceFilesAtPaths(globs)
    return { project, rootDir: dirname(tsconfig) }
  }
  if (args.tsconfig !== undefined) return `No tsconfig at ${tsconfig}`
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      strict: true,
    },
  })
  project.addSourceFilesAtPaths(globs.length > 0 ? globs : globsFor(cwd))
  return { project, rootDir: cwd }
}

/** The `@kontsedal/olas-core` version the project resolves, found the way Node looks. */
export function installedCoreVersion(from: string): string | undefined {
  let dir = resolve(from)
  for (;;) {
    const manifest = join(dir, 'node_modules', '@kontsedal', 'olas-core', 'package.json')
    if (existsSync(manifest)) {
      return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

function report(result: RunResult, scanned: number, dry: boolean, io: CliIO): void {
  const rel = (path: string): string => relative(io.cwd, path).replaceAll('\\', '/')
  io.log(
    `olas-codemod 1.0: ${count(scanned, 'file')} scanned${dry ? ', dry run (nothing is written)' : ''}`,
  )
  io.log('')
  const width = Math.max(...result.summaries.map((s) => s.name.length), 'transform'.length)
  io.log(`  ${'transform'.padEnd(width)}  files  sites  todos`)
  for (const s of result.summaries) {
    const cells = [s.files, s.sites, s.todos].map((n) => String(n).padStart(5)).join('  ')
    io.log(`  ${s.name.padEnd(width)}  ${cells}`)
  }
  io.log('')
  const sites = result.summaries.reduce((n, s) => n + s.sites, 0)
  const changed = `${count(result.changed.length, 'file')}, ${count(sites, 'site')}`
  io.log(`${dry ? 'Would change' : 'Changed'} ${changed}.`)
  for (const file of result.changed) io.log(`  ${rel(file.getFilePath())}`)
  io.log('')
  if (result.todos.length === 0) {
    io.log('No TODOs.')
    return
  }
  io.log(`${count(result.todos.length, 'TODO')}, to finish by hand:`)
  for (const t of result.todos) io.log(`  ${rel(t.file)}:${t.line} — ${t.transform}: ${t.reason}`)
}

const processIO: CliIO = {
  cwd: process.cwd(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
}

/**
 * The CLI. Returns the exit code: 0 when the run finished, TODOs or not; 1
 * for a usage error or a project with no source files.
 */
export function main(argv: readonly string[], io: CliIO = processIO): number {
  const args = parseArgs(argv)
  if (args.help) {
    io.log(USAGE)
    return 0
  }
  if (args.unknown !== undefined) {
    io.error(`Unknown option: ${args.unknown}\n\n${USAGE}`)
    return 1
  }
  if (args.target !== '1.0') {
    const what = args.target === undefined ? 'No migration target' : `Unknown target ${args.target}`
    io.error(`${what}: the one migration is \`1.0\`.\n\n${USAGE}`)
    return 1
  }
  const loaded = loadProject(args, io.cwd)
  if (typeof loaded === 'string') {
    io.error(loaded)
    return 1
  }
  const files = selectFiles(
    loaded.project,
    args.paths.map((p) => resolve(io.cwd, p)),
  )
  if (files.length === 0) {
    io.error(
      'No source files matched. Point --tsconfig at the config that includes your sources, such as tsconfig.app.json.',
    )
    return 1
  }
  const version = installedCoreVersion(loaded.rootDir)
  if (version !== undefined && Number.parseInt(version, 10) >= 1) {
    io.error(
      `@kontsedal/olas-core ${version} is installed. The type-driven rewrites (root.api, forms, ` +
        'mutations) recognize the 0.8 types, so they find nothing against 1.0. Run on a tree ' +
        'with 0.8 installed for the full migration.',
    )
  }
  const result = runCodemod(files, { rootDir: loaded.rootDir })
  // Save before printing, so a reader that closes the pipe early loses no write.
  if (!args.dry) for (const file of result.changed) file.saveSync()
  report(result, files.length, args.dry, io)
  return 0
}
