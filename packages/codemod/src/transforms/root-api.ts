import { Node, SyntaxKind } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { appendAccess } from '../util/ast'
import { isOldRoot } from '../util/shape'

export const APPLY_DEHYDRATED =
  '`applyDehydratedEntry` is removed: pass a whole `DehydratedState` to `root.hydrate(state)`'
export const MIXED_DESTRUCTURE =
  'this destructures root controls and api members together: take the api members from `root.api`'
export const ROOT_SPREAD =
  'this spreads a root: spread `root.api` for the api, and keep the controls'
export const RENAMED_CONTROL =
  'this destructures `__debug` or `applyDehydratedEntry`: 1.0 has `debug` and `hydrate(state)` instead'

/** The 0.8 root controls. Every other member of a 0.8 root was the app's api. */
const CONTROLS = new Set([
  'dispose',
  'suspend',
  'resume',
  'dehydrate',
  'waitForIdle',
  'bindQuery',
  'applyDehydratedEntry',
  '__debug',
])

/**
 * True when the type declares the member. A name it lacks is no api member:
 * `root.api` that an earlier run wrote is one, so a second run skips it.
 */
function hasMember(node: Node, name: string): boolean {
  return node.getType().getNonNullableType().getProperty(name) !== undefined
}

/**
 * A 1.0 root is a handle with the app's api on `.api`. The type checker tells
 * a 0.8 root apart by its controls, so `root.increment()` → `root.api.increment()`
 * rewrites only where the type proves `increment` is api.
 */
export const rootApi: Transform = {
  name: 'root-api',
  description:
    '`root.x` → `root.api.x` where the type proves `x` is api; `root.__debug` → `root.debug`',
  run: (files) =>
    runPerFile('root-api', files, (file, changes) => {
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const target = access.getExpression()
        if (!isOldRoot(target)) continue
        const name = access.getName()
        if (name === '__debug') {
          changes.replaceNode(access.getNameNode(), 'debug')
          changes.site()
        } else if (name === 'applyDehydratedEntry') {
          changes.todo(access, APPLY_DEHYDRATED)
        } else if (!CONTROLS.has(name) && hasMember(target, name)) {
          // `root?.count` → `root?.api.count`: the `.api` goes after the `?.`.
          if (access.hasQuestionDotToken()) changes.insert(access.getNameNode().getStart(), 'api.')
          else changes.push(...appendAccess(target, 'api'))
          changes.site()
        }
      }

      for (const decl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const pattern = decl.getNameNode()
        const init = decl.getInitializer()
        if (init === undefined || !Node.isObjectBindingPattern(pattern) || !isOldRoot(init))
          continue
        const names = pattern
          .getElements()
          .map((el) => el.getPropertyNameNode()?.getText() ?? el.getName())
        const api = names.filter((n) => !CONTROLS.has(n))
        const renamed = names.some((n) => n === '__debug' || n === 'applyDehydratedEntry')
        if (api.length === names.length) {
          changes.push(...appendAccess(init, 'api'))
          changes.site()
        } else if (api.length > 0) {
          changes.todo(decl, MIXED_DESTRUCTURE)
        } else if (renamed) {
          changes.todo(decl, RENAMED_CONTROL)
        }
      }

      for (const spread of file.getDescendantsOfKind(SyntaxKind.SpreadAssignment)) {
        if (isOldRoot(spread.getExpression())) changes.todo(spread, ROOT_SPREAD)
      }
    }),
}
