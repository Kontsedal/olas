import { type Node, type SourceFile, ts } from 'ts-morph'
import type { Todo, TransformResult } from './types'
import { ImportAdder } from './util/imports'

/** Replace `[start, end)` of a file's text with `text`. An insertion has `start === end`. */
export type Edit = { readonly start: number; readonly end: number; readonly text: string }

/**
 * The edits and TODOs one transform collects for one file. Edits are plain
 * positions into the file's current text. They are applied back to front in
 * one pass, so a site nested inside another site keeps both edits, and no
 * node is read after the text under it changed.
 */
export class FileChanges {
  readonly edits: Edit[] = []
  readonly imports: ImportAdder
  private sites = 0

  constructor(
    readonly file: SourceFile,
    readonly transform: string,
    private readonly todos: Todo[],
  ) {
    this.imports = new ImportAdder(file)
  }

  insert(pos: number, text: string): void {
    this.edits.push({ start: pos, end: pos, text })
  }

  replace(start: number, end: number, text: string): void {
    this.edits.push({ start, end, text })
  }

  replaceNode(node: Node, text: string): void {
    this.replace(node.getStart(), node.getEnd(), text)
  }

  push(...edits: Edit[]): void {
    this.edits.push(...edits)
  }

  /** Count one rewritten site. */
  site(): void {
    this.sites += 1
  }

  todo(node: Node, reason: string): void {
    this.todoAt(node.getStartLineNumber(), reason)
  }

  todoAt(line: number, reason: string): void {
    this.todos.push({
      file: this.file.getFilePath(),
      line,
      transform: this.transform,
      reason,
    })
  }

  /** Apply every edit to the file. Returns the number of sites rewritten. */
  apply(): number {
    const all = [...this.edits, ...this.imports.edits()]
    if (all.length === 0) return this.sites
    const original = this.file.getFullText()
    // Back to front. Same start: the later-collected edit goes first, so
    // insertions at one position keep the order they were collected in.
    const order = all.map((edit, index) => ({ edit, index }))
    order.sort(
      (a, b) => b.edit.start - a.edit.start || b.edit.end - a.edit.end || b.index - a.index,
    )
    let text = original
    let boundary = Number.POSITIVE_INFINITY
    for (const { edit } of order) {
      if (edit.end > boundary) {
        this.todoAt(
          this.file.getLineAndColumnAtPos(edit.start).line,
          'two rewrites overlap here; finish this site by hand',
        )
        continue
      }
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
      boundary = edit.start
    }
    if (text !== original) replaceKeepingNewlines(this.file, text, original)
    return this.sites
  }
}

/**
 * `replaceWithText` writes every line break as the project's `newLineKind`,
 * LF by default, which would turn a CRLF file into a whole-file diff. Set it
 * to the file's own line ending for the one write.
 */
function replaceKeepingNewlines(file: SourceFile, text: string, original: string): void {
  const settings = file.getProject().manipulationSettings
  const previous = settings.getNewLineKind()
  const crlf = original.includes('\r\n')
  settings.set({
    newLineKind: crlf ? ts.NewLineKind.CarriageReturnLineFeed : ts.NewLineKind.LineFeed,
  })
  try {
    file.replaceWithText(text)
  } finally {
    settings.set({ newLineKind: previous })
  }
}

/**
 * Run a per-file visitor over every file, collecting first and applying after.
 * Collecting everything before the first write keeps the type checker's
 * program valid for the whole pass.
 */
export function runPerFile(
  transform: string,
  files: readonly SourceFile[],
  visit: (file: SourceFile, changes: FileChanges) => void,
): TransformResult {
  const todos: Todo[] = []
  const pending = files.map((file) => {
    const changes = new FileChanges(file, transform, todos)
    visit(file, changes)
    return changes
  })
  let changed = 0
  for (const changes of pending) changed += changes.apply()
  return { changed, todos }
}
