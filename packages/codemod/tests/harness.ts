import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Project, type SourceFile, ts } from 'ts-morph'
import { expect } from 'vitest'
import type { Transform } from '../src/types'

export const FIXTURES = join(import.meta.dirname, 'fixtures')

/** The 0.8 type stubs every fixture compiles against. */
export const TYPES = readFileSync(join(FIXTURES, '_types.d.ts'), 'utf8')

const lf = (text: string): string => text.replace(/\r\n/g, '\n')

/** An in-memory project holding the 0.8 stubs, with nothing read from disk. */
export function memoryProject(): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  })
  project.createSourceFile('/types/olas.d.ts', TYPES)
  return project
}

/** A source file in a fresh in-memory project. */
export function memoryFile(text: string, path = '/src/input.ts'): SourceFile {
  return memoryProject().createSourceFile(path, lf(text))
}

export type FixtureRun = {
  readonly output: string
  readonly expected: string
  /** `line: reason`, for readable assertions. */
  readonly todos: readonly string[]
  readonly changed: number
}

/**
 * Run one transform on `fixtures/<name>/input.ts(x)` and read the matching
 * `output.ts(x)`. Line endings are normalized, so a checkout that converts
 * them does not change what is compared.
 */
export function runFixture(transform: Transform, name: string): FixtureRun {
  const dir = join(FIXTURES, name)
  const ext = existsSync(join(dir, 'input.tsx')) ? 'tsx' : 'ts'
  const file = memoryFile(readFileSync(join(dir, `input.${ext}`), 'utf8'), `/src/input.${ext}`)
  const result = transform.run([file], { rootDir: '/' })
  return {
    output: file.getFullText(),
    expected: lf(readFileSync(join(dir, `output.${ext}`), 'utf8')),
    todos: [...result.todos].sort((a, b) => a.line - b.line).map((t) => `${t.line}: ${t.reason}`),
    changed: result.changed,
  }
}

export type FixtureExpectation = {
  readonly changed: number
  readonly todos: ReadonlyArray<readonly [line: number, reason: string]>
  /**
   * Whether a second pass over the output changes nothing (default true).
   * Only `forms` is exempt: under the 0.8 types it resolves, the `form.value`
   * it writes still reads as the 0.8 signal.
   */
  readonly idempotent?: boolean
}

/** Run a fixture and assert its output, its site count and its TODOs. */
export function expectFixture(
  transform: Transform,
  name: string,
  expected: FixtureExpectation,
): void {
  const run = runFixture(transform, name)
  expect(run.output).toBe(run.expected)
  expect(run.changed).toBe(expected.changed)
  expect(run.todos).toEqual(expected.todos.map(([line, reason]) => `${line}: ${reason}`))
  if (expected.idempotent === false) return
  const ext = existsSync(join(FIXTURES, name, 'input.tsx')) ? 'tsx' : 'ts'
  const again = memoryFile(run.output, `/src/again.${ext}`)
  const second = transform.run([again], { rootDir: '/' })
  expect(again.getFullText()).toBe(run.output)
  expect(second.changed).toBe(0)
}
