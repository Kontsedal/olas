import { Node, SyntaxKind } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { importsOf, refOf } from '../util/olas'
import { isOldEntitiesPlugin } from '../util/shape'

export const ENTITY_STORE =
  'the entity store is a per-root service in 1.0: read it with `ctx.inject(Entities)`, or `root.inject(Entities)` outside a controller'
export const ENTITIES_PLUGIN_TYPE =
  '`EntitiesPlugin` is gone: the plugin is an `OlasPlugin`, and the store is an `EntityStore` from `ctx.inject(Entities)`'

const STORE_METHODS = new Set([
  'signal',
  'get',
  'upsert',
  'update',
  'invalidate',
  'entries',
  'bindings',
  'list',
])

/**
 * `entitiesPlugin` takes an options object, and returns a plugin only: the
 * store it used to double as is a scope service. `invalidate` is renamed
 * `remove`, because it never refetched.
 */
export const entities: Transform = {
  name: 'entities',
  description:
    '`entitiesPlugin([...])` → `entitiesPlugin({ entities: [...] })`; store `invalidate` → `remove`',
  run: (files) =>
    runPerFile('entities', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const ref = refOf(call.getExpression())
        if (ref?.pkg !== 'entities' || ref.name !== 'entitiesPlugin') continue
        const list = call.getArguments()[0]
        if (list === undefined || Node.isObjectLiteralExpression(list)) continue
        changes.replaceNode(list, `{ entities: ${list.getText()} }`)
        changes.site()
      }
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const name = access.getName()
        if (!STORE_METHODS.has(name) || !isOldEntitiesPlugin(access.getExpression())) continue
        if (name === 'invalidate') {
          changes.replaceNode(access.getNameNode(), 'remove')
          changes.site()
        }
        changes.todo(access, ENTITY_STORE)
      }
      for (const spec of importsOf(file, 'entities', 'EntitiesPlugin')) {
        changes.todo(spec, ENTITIES_PLUGIN_TYPE)
      }
    }),
}
