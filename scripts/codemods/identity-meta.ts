/**
 * 1.0 codemod: query and mutation identity, plugin `meta`, and the async
 * context objects.
 *
 *   defineQuery({ queryId: 'u', crossTab: true, … })  → defineQuery({ id: 'u', meta: { crossTab: true }, … })
 *   defineQuery({ key, fetcher })                      → defineQuery({ id: '<file>/<line>', key, fetcher })
 *   defineMutation({ mutationId: 'm', mutate })        → defineMutation({ id: 'm', mutate, meta: { persist: true } })
 *   createMutation(ctx, { name: 'save', persist: … })  → createMutation(ctx, { id: 'save', meta: { persist: … } })
 *   createMutation(ctx, { ...def, onSuccess })         → createMutation(ctx, def, { onSuccess })
 *   mutate: (vars, signal) => …                        → mutate: (vars, { signal }) => …
 *   createCache(ctx, (signal) => …)                    → createCache(ctx, ({ signal }) => …)
 *
 * Syntactic (callee names), so it needs no type information. A generated
 * `id` is only a placeholder: rename it to something stable and meaningful.
 * `defineMutation` defaulted to `persist: true` before 1.0, so a definition
 * without a `persist` field gains `meta: { persist: true }` to keep its
 * behaviour.
 *
 * Usage: tsx scripts/codemods/identity-meta.ts <glob> [<glob> ...]
 */
import { basename } from 'node:path'
import {
  type ArrowFunction,
  type FunctionExpression,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  Project,
  SyntaxKind,
} from 'ts-morph'

const HOOKS = new Set(['onMutate', 'onSuccess', 'onError', 'onSettled', 'detached'])

type Edit = { start: number; end: number; text: string }

function prop(obj: ObjectLiteralExpression, name: string) {
  return obj
    .getProperties()
    .find(
      (p) =>
        (p.isKind(SyntaxKind.PropertyAssignment) ||
          p.isKind(SyntaxKind.ShorthandPropertyAssignment) ||
          p.isKind(SyntaxKind.MethodDeclaration)) &&
        p.getName() === name,
    )
}

/** Text of a property's value, for moving it under `meta`. */
function valueText(p: Node): string {
  if (p.isKind(SyntaxKind.PropertyAssignment)) return p.getInitializerOrThrow().getText()
  if (p.isKind(SyntaxKind.ShorthandPropertyAssignment)) return p.getName()
  throw new Error(`unexpected property kind at ${p.getStartLineNumber()}`)
}

/** Remove a property together with its trailing comma. */
function removeProp(p: Node): Edit {
  const text = p.getSourceFile().getFullText()
  let end = p.getEnd()
  const rest = text.slice(end)
  const m = /^\s*,/.exec(rest)
  if (m) end += m[0].length
  return { start: p.getFullStart(), end, text: '' }
}

function renameKey(p: Node, to: string): Edit[] {
  if (p.isKind(SyntaxKind.PropertyAssignment)) {
    const n = p.getNameNode()
    return [{ start: n.getStart(), end: n.getEnd(), text: to }]
  }
  if (p.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
    return [{ start: p.getStart(), end: p.getEnd(), text: `${to}: ${p.getName()}` }]
  }
  return []
}

/** Insert text as the first property of an object literal. */
function prepend(obj: ObjectLiteralExpression, text: string): Edit {
  const open = obj.getStart() + 1
  const multiline = obj.getText().includes('\n')
  const first = obj.getProperties()[0]
  if (multiline && first !== undefined) {
    const indent = ' '.repeat(
      first.getStartLinePos() === first.getStart() ? 0 : first.getStart() - first.getStartLinePos(),
    )
    return { start: first.getStart(), end: first.getStart(), text: `${text},\n${indent}` }
  }
  return {
    start: open,
    end: open,
    text: obj.getProperties().length > 0 ? ` ${text},` : ` ${text} `,
  }
}

/** Append `meta: {…}` (or merge into an existing meta literal). */
function addMeta(obj: ObjectLiteralExpression, entries: string[], edits: Edit[]): void {
  if (entries.length === 0) return
  const existing = prop(obj, 'meta')
  if (existing?.isKind(SyntaxKind.PropertyAssignment)) {
    const init = existing.getInitializer()
    if (init?.isKind(SyntaxKind.ObjectLiteralExpression)) {
      const close = init.getEnd() - 1
      const sep = init.getProperties().length > 0 ? ', ' : ' '
      edits.push({ start: close, end: close, text: `${sep}${entries.join(', ')} ` })
      return
    }
  }
  const props = obj.getProperties()
  const last = props[props.length - 1]
  const text = `meta: { ${entries.join(', ')} }`
  if (last === undefined) {
    edits.push({ start: obj.getStart() + 1, end: obj.getStart() + 1, text: ` ${text} ` })
    return
  }
  const full = obj.getSourceFile().getFullText()
  const after = full.slice(last.getEnd())
  const hasComma = /^\s*,/.test(after)
  const multiline = obj.getText().includes('\n')
  const indent = ' '.repeat(last.getStart() - last.getStartLinePos())
  if (multiline) {
    const at = hasComma ? last.getEnd() + (/^\s*,/.exec(after)?.[0].length ?? 0) : last.getEnd()
    edits.push({ start: at, end: at, text: `${hasComma ? '' : ','}\n${indent}${text},` })
  } else {
    edits.push({ start: last.getEnd(), end: last.getEnd(), text: `, ${text}` })
  }
}

/**
 * Move one property under `meta`. With no `meta` literal to merge into, the
 * property is replaced in place, so the edit never overlaps a neighbour's.
 */
function moveToMeta(obj: ObjectLiteralExpression, p: Node, entry: string, edits: Edit[]): void {
  const existing = prop(obj, 'meta')
  if (existing?.isKind(SyntaxKind.PropertyAssignment)) {
    edits.push(removeProp(p))
    addMeta(obj, [entry], edits)
    return
  }
  edits.push({ start: p.getStart(), end: p.getEnd(), text: `meta: { ${entry} }` })
}

/** `(vars, signal) => …` → `(vars, { signal }) => …`; `(signal) => …` → `({ signal }) => …`. */
function signalParamToCtx(
  fn: ArrowFunction | FunctionExpression | MethodDeclaration,
  index: number,
  edits: Edit[],
): void {
  const param = fn.getParameters()[index]
  if (param === undefined) return
  const name = param.getNameNode()
  if (!name.isKind(SyntaxKind.Identifier)) return // already destructured
  const id = name.getText()
  const typeNode = param.getTypeNode()
  const replacement = id === 'signal' ? '{ signal }' : `{ signal: ${id} }`
  if (typeNode !== undefined) {
    // `(signal: AbortSignal)` → `({ signal }: { signal: AbortSignal })` would
    // be noise; the context type is inferred from the callee.
    edits.push({ start: param.getStart(), end: param.getEnd(), text: replacement })
  } else {
    edits.push({ start: name.getStart(), end: name.getEnd(), text: replacement })
  }
  // An arrow with a single bare parameter has no parens: `signal => …`.
  if (
    fn.isKind(SyntaxKind.ArrowFunction) &&
    !fn.getText().trimStart().startsWith('(') &&
    !fn.getText().trimStart().startsWith('async (')
  ) {
    const last = edits[edits.length - 1] as Edit
    last.text = `(${last.text})`
  }
}

function mutateFn(obj: ObjectLiteralExpression) {
  const p = prop(obj, 'mutate')
  if (p === undefined) return undefined
  if (p.isKind(SyntaxKind.MethodDeclaration)) return p
  if (!p.isKind(SyntaxKind.PropertyAssignment)) return undefined
  const init = p.getInitializer()
  if (init?.isKind(SyntaxKind.ArrowFunction) || init?.isKind(SyntaxKind.FunctionExpression))
    return init
  return undefined
}

let total = 0
const project = new Project({ skipAddingFilesFromTsConfig: true })
for (const glob of process.argv.slice(2)) project.addSourceFilesAtPaths(glob)

for (const file of project.getSourceFiles()) {
  const path = file.getFilePath()
  if (path.includes('/node_modules/') || path.includes('/dist/')) continue
  const stem = basename(path)
    .replace(/\.(test|spec)?\.?tsx?$/, '')
    .replace(/\.tsx?$/, '')
  const edits: Edit[] = []

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText()
    const args = call.getArguments()

    if (callee === 'defineQuery' || callee === 'defineInfiniteQuery') {
      const obj = args[0]
      if (!obj?.isKind(SyntaxKind.ObjectLiteralExpression)) continue
      const qid = prop(obj, 'queryId')
      if (qid !== undefined) edits.push(...renameKey(qid, 'id'))
      else if (prop(obj, 'id') === undefined) {
        edits.push(prepend(obj, `id: '${stem}/${call.getStartLineNumber()}'`))
      }
      const ct = prop(obj, 'crossTab')
      if (ct !== undefined) {
        const raw = valueText(ct)
        moveToMeta(obj, ct, `crossTab: ${raw === "'data'" ? 'true' : raw}`, edits)
      }
      continue
    }

    if (callee === 'defineMutation') {
      const obj = args[0]
      if (!obj?.isKind(SyntaxKind.ObjectLiteralExpression)) continue
      const mid = prop(obj, 'mutationId')
      if (mid !== undefined) edits.push(...renameKey(mid, 'id'))
      const name = prop(obj, 'name')
      const persist = prop(obj, 'persist')
      if (persist !== undefined) {
        const raw = valueText(persist)
        if (raw === 'false') edits.push(removeProp(persist))
        else moveToMeta(obj, persist, `persist: ${raw}`, edits)
        if (name !== undefined) edits.push(removeProp(name))
      } else if (name !== undefined) {
        // Reuse the slot `name` leaves, so no append collides with its removal.
        moveToMeta(obj, name, 'persist: true', edits)
      } else {
        addMeta(obj, ['persist: true'], edits)
      }
      const fn = mutateFn(obj)
      if (fn !== undefined) signalParamToCtx(fn, 1, edits)
      continue
    }

    if (callee === 'createMutation') {
      const obj = args[1]
      if (!obj?.isKind(SyntaxKind.ObjectLiteralExpression)) continue
      const props = obj.getProperties()
      const spread = props[0]
      // `{ ...def, onSuccess }` → `(def, { onSuccess })`
      if (
        spread?.isKind(SyntaxKind.SpreadAssignment) &&
        spread.getExpression().isKind(SyntaxKind.Identifier) &&
        props
          .slice(1)
          .every(
            (p) =>
              !p.isKind(SyntaxKind.SpreadAssignment) &&
              HOOKS.has((p as { getName(): string }).getName()),
          )
      ) {
        const defName = spread.getExpression().getText()
        const rest = props.slice(1).map((p) => p.getText())
        const replacement =
          rest.length === 0 ? defName : `${defName}, {\n${rest.map((r) => `  ${r},`).join('\n')}\n}`
        edits.push({ start: obj.getStart(), end: obj.getEnd(), text: replacement })
        continue
      }
      const mid = prop(obj, 'mutationId')
      const name = prop(obj, 'name')
      if (mid !== undefined) {
        edits.push(...renameKey(mid, 'id'))
        if (name !== undefined) edits.push(removeProp(name))
      } else if (name !== undefined && prop(obj, 'id') === undefined) {
        edits.push(...renameKey(name, 'id'))
      }
      const persist = prop(obj, 'persist')
      if (persist !== undefined) {
        const raw = valueText(persist)
        if (raw === 'false') edits.push(removeProp(persist))
        else moveToMeta(obj, persist, `persist: ${raw}`, edits)
      }
      const fn = mutateFn(obj)
      if (fn !== undefined) signalParamToCtx(fn, 1, edits)
      continue
    }

    if (callee === 'createCache') {
      const fn = args[1]
      if (fn?.isKind(SyntaxKind.ArrowFunction) || fn?.isKind(SyntaxKind.FunctionExpression)) {
        signalParamToCtx(fn, 0, edits)
      }
    }
  }

  if (edits.length === 0) continue
  let text = file.getFullText()
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  file.replaceWithText(text)
  file.saveSync()
  total += edits.length
  console.log(`[identity-meta] ${edits.length.toString().padStart(4)} ${path}`)
}
console.log(`[identity-meta] ${total} edits`)
