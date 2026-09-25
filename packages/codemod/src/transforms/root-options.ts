import { Node, type ObjectLiteralExpression, SyntaxKind } from 'ts-morph'
import { type FileChanges, runPerFile } from '../edits'
import type { Transform } from '../types'
import {
  appendMember,
  appendProp,
  literalValue,
  type Prop,
  prop,
  removeProp,
  valueText,
} from '../util/ast'
import { isRef, refOf, specifierOf } from '../util/olas'
import { isOldRouterAdapter } from '../util/shape'

export const OPTIONS_UNSEEN =
  'these root options are not an object literal written here: add `queries: queryEngine()`, and move the query defaults into `queryEngine({ defaults })`'
export const ENGINE_UNSEEN =
  "move `defaultQueryOptions`, `refetchOnWindowFocus` and `refetchOnReconnect` into the `defaults` of this root's `queryEngine(...)`"
export const ROUTER_SCOPES =
  'the router installs as a plugin in 1.0: `plugins: [adapter.plugin]` replaces `scopes: adapter.scopes`'
export const ENGINE_HIDDEN =
  'a local `queryEngine` hides the import here: add `queries: queryEngine()` by hand'

const CORE = specifierOf('core')
const FLAGS = ['refetchOnWindowFocus', 'refetchOnReconnect'] as const

/**
 * The `defaults` for the engine, from the moved options. A flag that the
 * `defaultQueryOptions` literal also sets is dropped: the literal won in 0.8.
 */
function defaultsText(obj: ObjectLiteralExpression): string | undefined {
  const dqo = prop(obj, 'defaultQueryOptions')
  const base = dqo === undefined ? undefined : valueText(dqo)
  const literal = literalValue(dqo)
  const flags: string[] = []
  for (const flag of FLAGS) {
    const p = prop(obj, flag)
    const value = p === undefined ? undefined : valueText(p)
    if (value === undefined || (literal !== undefined && prop(literal, flag) !== undefined))
      continue
    flags.push(`${flag}: ${value}`)
  }
  if (flags.length === 0) return base
  if (base === undefined) return `{ ${flags.join(', ')} }`
  if (literal !== undefined) {
    return `{ ${[...flags, ...literal.getProperties().map((p) => p.getText())].join(', ')} }`
  }
  return `{ ${flags.join(', ')}, ...${base} }`
}

function routerScopes(obj: ObjectLiteralExpression, changes: FileChanges): void {
  const scopes = prop(obj, 'scopes')
  if (scopes === undefined || !Node.isPropertyAssignment(scopes)) return
  const init = scopes.getInitializerOrThrow()
  const adapter =
    Node.isPropertyAccessExpression(init) && init.getName() === 'scopes'
      ? init.getExpression()
      : undefined
  if (adapter === undefined || !isOldRouterAdapter(adapter)) {
    const built = init
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .some((p) => p.getName() === 'scopes' && isOldRouterAdapter(p.getExpression()))
    if (built) changes.todo(scopes, ROUTER_SCOPES)
    return
  }
  const plugin = `${adapter.getText()}.plugin`
  const plugins = prop(obj, 'plugins')
  if (plugins === undefined) {
    changes.replaceNode(scopes, `plugins: [${plugin}]`)
    changes.site()
    return
  }
  const list = Node.isPropertyAssignment(plugins) ? plugins.getInitializer() : undefined
  if (!Node.isArrayLiteralExpression(list)) {
    changes.todo(scopes, ROUTER_SCOPES)
    return
  }
  changes.push(removeProp(scopes), appendMember(list, list.getElements(), plugin))
  changes.site()
}

function engine(obj: ObjectLiteralExpression, addEngine: boolean, changes: FileChanges): void {
  const moved = ['defaultQueryOptions', ...FLAGS]
    .map((name) => prop(obj, name))
    .filter((p): p is Prop => p !== undefined)
  const queries = prop(obj, 'queries')
  if (queries === undefined) {
    if (!addEngine && moved.length === 0) return
    if (!changes.imports.need(CORE, 'queryEngine', obj)) {
      changes.todo(obj, ENGINE_HIDDEN)
      return
    }
    const defaults = defaultsText(obj)
    const value =
      defaults === undefined ? 'queryEngine()' : `queryEngine({ defaults: ${defaults} })`
    const [first, ...rest] = moved
    if (first === undefined) {
      changes.push(appendProp(obj, `queries: ${value}`))
    } else {
      changes.replaceNode(first, `queries: ${value}`)
      for (const p of rest) changes.push(removeProp(p))
    }
    changes.site()
    return
  }
  if (moved.length === 0) return
  const init = Node.isPropertyAssignment(queries) ? queries.getInitializer() : undefined
  if (
    Node.isCallExpression(init) &&
    isRef(init.getExpression(), 'core', 'queryEngine') &&
    init.getArguments().length === 0
  ) {
    changes.insert(init.getEnd() - 1, `{ defaults: ${defaultsText(obj)} }`)
    for (const p of moved) changes.push(removeProp(p))
    changes.site()
    return
  }
  changes.todo(queries, ENGINE_UNSEEN)
}

function rewrite(obj: ObjectLiteralExpression, addEngine: boolean, changes: FileChanges): void {
  routerScopes(obj, changes)
  engine(obj, addEngine, changes)
}

/**
 * The query engine is explicit, and root-wide query defaults live on it:
 * `createRoot(app, { deps, defaultQueryOptions })` →
 * `createRoot(app, { deps, queries: queryEngine({ defaults }) })`. Every 0.8
 * root had a query client, so every `createRoot` gains `queries: queryEngine()`
 * to keep that. `createTestController` supplies an engine by default, so it
 * only moves the defaults.
 */
export const rootOptions: Transform = {
  name: 'root-options',
  description:
    '`createRoot` gains `queries: queryEngine()`; `defaultQueryOptions` and the refetch flags → `queryEngine({ defaults })`; router `scopes` → `plugins`',
  run: (files) =>
    runPerFile('root-options', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const ref = refOf(call.getExpression())
        if (ref?.pkg !== 'core') continue
        const options = call.getArguments()[ref.name === 'queryEngine' ? 0 : 1]
        if (ref.name === 'queryEngine') {
          const dqo = Node.isObjectLiteralExpression(options)
            ? prop(options, 'defaultQueryOptions')
            : undefined
          if (dqo !== undefined && Node.isPropertyAssignment(dqo)) {
            changes.replaceNode(dqo.getNameNode(), 'defaults')
            changes.site()
          }
        } else if (ref.name === 'createRoot' || ref.name === 'createTestController') {
          if (Node.isObjectLiteralExpression(options)) {
            rewrite(options, ref.name === 'createRoot', changes)
          } else if (ref.name === 'createRoot' && options !== undefined) {
            changes.todo(options, OPTIONS_UNSEEN)
          }
        }
      }
      const elements = [
        ...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
        ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ]
      for (const el of elements) {
        if (!isRef(el.getTagNameNode(), 'react', 'HydrationBoundary')) continue
        const attr = el.getAttribute('options')
        const expr = Node.isJsxAttribute(attr) ? attr.getInitializer() : undefined
        const value = Node.isJsxExpression(expr) ? expr.getExpression() : undefined
        if (Node.isObjectLiteralExpression(value)) rewrite(value, true, changes)
        else if (value !== undefined) changes.todo(value, OPTIONS_UNSEEN)
      }
    }),
}
