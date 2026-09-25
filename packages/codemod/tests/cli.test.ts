import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installedCoreVersion, main, parseArgs, USAGE } from '../src/main'
import { SUBMIT_RESULT } from '../src/transforms/forms'
import { PLACEHOLDER_ID } from '../src/transforms/identity-meta'
import { FIXTURES } from './harness'

const PROJECT = join(FIXTURES, 'project')
const FILES = ['app.ts', 'olas.ts', 'queries.ts', 'untouched.ts', 'view.tsx']
const temps: string[] = []

/** A temp copy of the fixture project, with the 0.8 stubs as its installed types. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olas-codemod-'))
  temps.push(dir)
  cpSync(join(PROJECT, 'input'), dir, { recursive: true })
  mkdirSync(join(dir, 'types'))
  cpSync(join(FIXTURES, '_types.d.ts'), join(dir, 'types', 'olas.d.ts'))
  return dir
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n')
const read = (...path: string[]): string => lf(readFileSync(join(...path), 'utf8'))

function run(argv: string[], cwd: string) {
  const out: string[] = []
  const err: string[] = []
  const code = main(argv, { cwd, log: (m) => out.push(m), error: (m) => err.push(m) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

function expectMigrated(dir: string): void {
  for (const file of FILES) {
    expect(read(dir, 'src', file), file).toBe(read(PROJECT, 'expected', 'src', file))
  }
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('olas-codemod 1.0', () => {
  it('migrates a multi-file project in place and lists the TODOs', () => {
    const dir = project()
    const { code, out, err } = run(['1.0'], dir)
    expect(code).toBe(0)
    expect(err).toBe('')
    expectMigrated(dir)
    expect(out).toContain('olas-codemod 1.0: 5 files scanned')
    expect(out).toMatch(/root-api\s+1\s+4\s+0/)
    expect(out).toContain('Changed 4 files, 29 sites.')
    expect(out).toContain('  src/view.tsx')
    expect(out).toContain('2 TODOs, to finish by hand:')
    expect(out).toContain(`  src/app.ts:32 — forms: ${SUBMIT_RESULT}`)
    expect(out).toContain(`  src/queries.ts:10 — identity-meta: ${PLACEHOLDER_ID}`)
  })

  it('writes nothing with --dry', () => {
    const dir = project()
    const { code, out } = run(['1.0', '--dry'], dir)
    expect(code).toBe(0)
    expect(out).toContain('5 files scanned, dry run (nothing is written)')
    expect(out).toContain('Would change 4 files, 29 sites.')
    for (const file of FILES)
      expect(read(dir, 'src', file)).toBe(read(PROJECT, 'input', 'src', file))
  })

  it('rewrites only the files under the given paths', () => {
    const dir = project()
    const { code, out } = run(['1.0', 'src/olas.ts'], dir)
    expect(code).toBe(0)
    expect(out).toContain('1 file scanned')
    expect(out).toContain('Changed 1 file, 2 sites.')
    expect(out).toContain('No TODOs.')
    expect(read(dir, 'src', 'olas.ts')).toBe(read(PROJECT, 'expected', 'src', 'olas.ts'))
    expect(read(dir, 'src', 'app.ts')).toBe(read(PROJECT, 'input', 'src', 'app.ts'))
  })

  it('loads the sources under the working directory when there is no tsconfig', () => {
    const dir = project()
    unlinkSync(join(dir, 'tsconfig.json'))
    const { code } = run(['1.0'], dir)
    expect(code).toBe(0)
    expectMigrated(dir)
  })

  it('takes --tsconfig in both spellings', () => {
    const dir = project()
    expect(run(['1.0', '--tsconfig', 'tsconfig.json', '--dry'], dir).code).toBe(0)
    expect(run(['1.0', '--tsconfig=tsconfig.json'], dir).code).toBe(0)
    expectMigrated(dir)
  })

  it('warns when the project resolves a 1.x core, and still runs', () => {
    const dir = project()
    const core = join(dir, 'node_modules', '@kontsedal', 'olas-core')
    mkdirSync(core, { recursive: true })
    writeFileSync(
      join(core, 'package.json'),
      '{ "name": "@kontsedal/olas-core", "version": "1.0.0" }',
    )
    const { code, err } = run(['1.0', '--dry'], dir)
    expect(code).toBe(0)
    expect(err).toContain('@kontsedal/olas-core 1.0.0 is installed')
    expect(installedCoreVersion(join(dir, 'src'))).toBe('1.0.0')
  })

  it('stays quiet about a 0.x core', () => {
    const dir = project()
    const core = join(dir, 'node_modules', '@kontsedal', 'olas-core')
    mkdirSync(core, { recursive: true })
    writeFileSync(join(core, 'package.json'), '{ "version": "0.8.0" }')
    expect(run(['1.0', '--dry'], dir).err).toBe('')
  })

  it('fails on a tsconfig that is not there, a path that is not there, or no sources', () => {
    const dir = project()
    const missingConfig = run(['1.0', '--tsconfig', 'nope.json'], dir)
    expect(missingConfig.code).toBe(1)
    expect(missingConfig.err).toContain('No tsconfig at')
    const missingPath = run(['1.0', 'nope'], dir)
    expect(missingPath.code).toBe(1)
    expect(missingPath.err).toContain('No such path')
    writeFileSync(join(dir, 'empty.json'), '{ "files": ["types/olas.d.ts"] }')
    const empty = run(['1.0', '--tsconfig', 'empty.json'], dir)
    expect(empty.code).toBe(1)
    expect(empty.err).toContain('No source files matched')
  })

  it('prints the usage for --help, and fails on bad arguments', () => {
    const dir = project()
    expect(run(['--help'], dir)).toEqual({ code: 0, out: USAGE, err: '' })
    expect(run(['-h'], dir).out).toBe(USAGE)
    const unknown = run(['1.0', '--force'], dir)
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('Unknown option: --force')
    const none = run([], dir)
    expect(none.code).toBe(1)
    expect(none.err).toContain('No migration target')
    const other = run(['2.0'], dir)
    expect(other.code).toBe(1)
    expect(other.err).toContain('Unknown target 2.0')
  })

  it('parses arguments in any order', () => {
    expect(parseArgs(['src', '1.0', '--dry', 'lib', '--tsconfig'])).toEqual({
      target: 'src',
      tsconfig: undefined,
      dry: true,
      help: false,
      paths: ['1.0', 'lib'],
      unknown: undefined,
    })
    expect(parseArgs(['-x', '--y']).unknown).toBe('-x')
  })
})

describe('the bin entry', () => {
  it('runs main on the process arguments and sets the exit code', async () => {
    const argv = process.argv
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.argv = ['node', 'olas-codemod', '--help']
      vi.resetModules()
      await import('../src/cli')
      expect(process.exitCode).toBe(0)
      expect(log).toHaveBeenCalledWith(USAGE)
      process.argv = ['node', 'olas-codemod', '--nope']
      vi.resetModules()
      await import('../src/cli')
      expect(process.exitCode).toBe(1)
      expect(error).toHaveBeenCalled()
    } finally {
      process.argv = argv
      process.exitCode = 0
      log.mockRestore()
      error.mockRestore()
    }
  })
})
