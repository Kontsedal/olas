import { Node, SyntaxKind } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { specifierOf } from '../util/olas'
import { isCtx } from '../util/shape'

export const SESSION =
  '`ctx.session` is removed: use `ctx.attach(def, props)`, which returns `{ api, dispose, suspend, resume }`'

/** `ctx.<method>(...)` → `<function>(ctx, ...)`. */
const TAKES_CTX = new Map([
  ['field', 'createField'],
  ['form', 'createForm'],
  ['fieldArray', 'createFieldArray'],
  ['cache', 'createCache'],
  ['use', 'createQuery'],
  ['mutation', 'createMutation'],
  ['bindQuery', 'bindQuery'],
])

/** `ctx.<method>(...)` → `<function>(...)`: plain re-exports with no lifetime to bind. */
const PLAIN = new Map([
  ['signal', 'signal'],
  ['computed', 'computed'],
])

const CORE = specifierOf('core')

/**
 * The lifetime-owned primitives are free functions that take `ctx` first,
 * and `ctx.signal` / `ctx.computed` are the standalone `signal` / `computed`.
 * Each rewrite imports the function from `@kontsedal/olas-core`.
 */
export const ctxPrimitives: Transform = {
  name: 'ctx-primitives',
  description:
    '`ctx.field(...)` → `createField(ctx, ...)` (and form, fieldArray, cache, use, mutation); `ctx.signal` → `signal`',
  run: (files) =>
    runPerFile('ctx-primitives', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression()
        if (!Node.isPropertyAccessExpression(callee)) continue
        const method = callee.getName()
        const takesCtx = TAKES_CTX.get(method)
        const plain = PLAIN.get(method)
        if (takesCtx === undefined && plain === undefined && method !== 'session') continue
        const receiver = callee.getExpression()
        if (!isCtx(receiver)) continue
        if (method === 'session') {
          changes.todo(call, SESSION)
          continue
        }
        const fn = (takesCtx ?? plain) as string
        if (!changes.imports.need(CORE, fn, call)) {
          changes.todo(
            call,
            `a local \`${fn}\` hides the import here: rewrite \`ctx.${method}\` by hand`,
          )
          continue
        }
        changes.replace(callee.getStart(), callee.getEnd(), fn)
        if (takesCtx !== undefined) {
          const ctx = receiver.getText()
          const first = call.getArguments()[0]
          if (first === undefined) {
            changes.insert(call.getEnd() - 1, ctx)
          } else if (first.getStartLineNumber() !== callee.getEndLineNumber()) {
            const indent = ' '.repeat(first.getStart() - first.getStartLinePos())
            changes.insert(first.getStart(), `${ctx},\n${indent}`)
          } else {
            changes.insert(first.getStart(), `${ctx}, `)
          }
        }
        changes.site()
      }
    }),
}
