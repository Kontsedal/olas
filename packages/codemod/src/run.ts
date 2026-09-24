import type { Project, SourceFile } from 'ts-morph'
import { transforms as all } from './transforms'
import type { Todo, Transform } from './types'

/** What one transform did across the run. */
export type TransformSummary = {
  readonly name: string
  readonly description: string
  /** Files whose text this transform changed. */
  readonly files: number
  /** Sites it rewrote. */
  readonly sites: number
  /** TODOs it reported. */
  readonly todos: number
}

export type RunOptions = {
  /** Directory that placeholder ids are relative to: the project root. */
  readonly rootDir: string
  /** The transforms to run, in order. Defaults to every 1.0 transform. */
  readonly transforms?: readonly Transform[]
}

export type RunResult = {
  readonly summaries: readonly TransformSummary[]
  /** Every TODO, sorted by file and line, without duplicates. */
  readonly todos: readonly Todo[]
  /** The files whose text differs from before the run. Nothing is saved. */
  readonly changed: readonly SourceFile[]
}

/** A path compared the way file systems that ignore drive-letter case need. */
const pathKey = (path: string): string =>
  path.replaceAll('\\', '/').replace(/^[A-Z]:/, (drive) => drive.toLowerCase())

/**
 * The files the codemod may rewrite: the project's own sources, not
 * declaration files, not `node_modules`, not build output. With `paths`,
 * only files at or under one of them.
 */
export function selectFiles(project: Project, paths: readonly string[] = []): SourceFile[] {
  const roots = paths.map(pathKey)
  return project.getSourceFiles().filter((file) => {
    const path = pathKey(file.getFilePath())
    if (file.isDeclarationFile() || /\/(node_modules|dist)\//.test(path)) return false
    return roots.length === 0 || roots.some((root) => path === root || path.startsWith(`${root}/`))
  })
}

/** Run the transforms over the files in memory, in order, and report what each did. */
export function runCodemod(files: readonly SourceFile[], options: RunOptions): RunResult {
  const original = files.map((f) => f.getFullText())
  const summaries: TransformSummary[] = []
  const todos: Todo[] = []
  for (const transform of options.transforms ?? all) {
    const before = files.map((f) => f.getFullText())
    const result = transform.run(files, { rootDir: options.rootDir })
    summaries.push({
      name: transform.name,
      description: transform.description,
      files: files.filter((f, i) => f.getFullText() !== before[i]).length,
      sites: result.changed,
      todos: result.todos.length,
    })
    todos.push(...result.todos)
  }
  const seen = new Set<string>()
  const unique = todos.filter((t) => {
    const key = `${t.file}\0${t.line}\0${t.transform}\0${t.reason}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return {
    summaries,
    todos: unique,
    changed: files.filter((f, i) => f.getFullText() !== original[i]),
  }
}
