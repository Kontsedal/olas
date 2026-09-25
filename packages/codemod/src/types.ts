import type { SourceFile } from 'ts-morph'

/** A site the codemod found but could not rewrite safely. */
export type Todo = {
  /**
   * Absolute path of the file, with forward slashes.
   */
  readonly file: string
  /**
   * 1-based line of the site.
   */
  readonly line: number
  /**
   * Name of the transform that reported it.
   */
  readonly transform: string
  /**
   * What to change by hand, in one line.
   */
  readonly reason: string
}

/** What one transform did to the files it was given. */
export type TransformResult = {
  /**
   * Sites rewritten. One site can take more than one text edit.
   */
  readonly changed: number
  readonly todos: readonly Todo[]
}

/** Shared settings every transform receives. */
export type TransformContext = {
  /**
   * Directory that placeholder ids are relative to.
   */
  readonly rootDir: string
}

/**
 * One 0.8 → 1.0 rewrite. `run` edits the given files in place, in memory; the
 * caller decides whether to save them.
 */
export type Transform = {
  readonly name: string
  /**
   * One line for the summary and the README table.
   */
  readonly description: string
  run(files: readonly SourceFile[], context: TransformContext): TransformResult
}
