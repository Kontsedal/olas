import { Node, SyntaxKind } from 'ts-morph'
import { type FileChanges, runPerFile } from '../edits'
import type { Transform } from '../types'
import { type FunctionLiteral, functionLiteralOf, prop } from '../util/ast'
import { refOf } from '../util/olas'

export const MUTATE_REFERENCE =
  '`mutate` receives `{ signal, deps }` as its second argument in 1.0, not the `AbortSignal`: check the function passed here'
export const CACHE_REFERENCE =
  "`createCache`'s fetcher receives `{ signal, deps }` in 1.0, not the `AbortSignal`: check the function passed here"

/**
 * `(vars, signal) => …` → `(vars, { signal }) => …`. A parameter already
 * destructured is left alone. A type annotation is dropped: the context's
 * type comes from the callee.
 */
function signalToContext(fn: FunctionLiteral, index: number, changes: FileChanges): void {
  const param = fn.getParameters()[index]
  if (param === undefined || param.isRestParameter()) return
  const name = param.getNameNode()
  if (!Node.isIdentifier(name)) return
  const id = name.getText()
  let text = id === 'signal' ? '{ signal }' : `{ signal: ${id} }`
  // `signal => …` has no parentheses to hold a pattern.
  if (Node.isArrowFunction(fn) && fn.getFirstChildByKind(SyntaxKind.OpenParenToken) === undefined) {
    text = `(${text})`
  }
  const end = param.getTypeNode() === undefined ? name.getEnd() : param.getEnd()
  changes.replace(name.getStart(), end, text)
  changes.site()
}

/** True when a value's call signature takes at least `count` parameters. */
function takes(value: Node, count: number): boolean {
  return value
    .getType()
    .getCallSignatures()
    .some((s) => s.getParameters().length >= count)
}

/**
 * A mutation's `mutate` and a local cache's fetcher receive the same
 * `{ signal, deps }` context a query fetcher does.
 */
export const mutateContext: Transform = {
  name: 'mutate-context',
  description:
    '`mutate: (vars, signal) => …` → `(vars, { signal }) => …`; `createCache(ctx, (signal) => …)` → `({ signal }) => …`',
  run: (files) =>
    runPerFile('mutate-context', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const ref = refOf(call.getExpression())
        if (ref?.pkg !== 'core') continue
        const args = call.getArguments()
        if (ref.name === 'createCache') {
          const fetcher = args[1]
          const fn = functionLiteralOf(fetcher)
          if (fn !== undefined) signalToContext(fn, 0, changes)
          else if (fetcher !== undefined && takes(fetcher, 1))
            changes.todo(fetcher, CACHE_REFERENCE)
          continue
        }
        if (ref.name !== 'defineMutation' && ref.name !== 'createMutation') continue
        const spec = args[ref.name === 'defineMutation' ? 0 : 1]
        if (!Node.isObjectLiteralExpression(spec)) continue
        const mutate = prop(spec, 'mutate')
        if (mutate === undefined) continue
        const fn = functionLiteralOf(mutate)
        if (fn !== undefined) {
          signalToContext(fn, 1, changes)
        } else {
          const value = Node.isPropertyAssignment(mutate) ? mutate.getInitializerOrThrow() : mutate
          if (takes(value, 2)) changes.todo(mutate, MUTATE_REFERENCE)
        }
      }
    }),
}
