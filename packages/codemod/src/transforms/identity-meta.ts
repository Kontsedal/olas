import { relative } from 'node:path'
import { type CallExpression, Node, type ObjectLiteralExpression, SyntaxKind } from 'ts-morph'
import { type FileChanges, runPerFile } from '../edits'
import type { Transform, TransformContext } from '../types'
import {
  addMeta,
  moveToMeta,
  prependProp,
  prop,
  removeProp,
  renameKey,
  valueText,
} from '../util/ast'
import { refOf } from '../util/olas'
import { isOldMutationDef } from '../util/shape'

export const PLACEHOLDER_ID =
  'placeholder `id`: every shared query needs a stable, unique `id` in 1.0, the same in server and client bundles'
export const QUERY_SPEC_UNSEEN =
  'this spec is not an object literal written here: give it an `id` (required in 1.0) and move `crossTab` under `meta`'
export const MUTATION_SPEC_UNSEEN =
  'this spec is not an object literal written here: rename `mutationId` to `id`, drop `name`, and move `persist` under `meta`'
export const MUTATION_ID =
  '`defineMutation` requires an `id` in 1.0, as it required a `mutationId` in 0.8'
export const DEFINITION_HOOKS =
  '`defineMutation` takes no lifecycle hooks in 1.0: pass them where the mutation is owned, as `createMutation(ctx, def, hooks)`'
export const SPREAD_DEFINITION =
  'this spreads a mutation definition next to more than hooks: pass the definition second and the hooks third, `createMutation(ctx, def, hooks)`'

const HOOKS = new Set(['onMutate', 'onSuccess', 'onError', 'onSettled', 'detached'])

function placeholderId(call: CallExpression, context: TransformContext): string {
  const path = relative(context.rootDir, call.getSourceFile().getFilePath()).replaceAll('\\', '/')
  return `${path}:${call.getStartLineNumber()}`
}

function querySpec(call: CallExpression, changes: FileChanges, context: TransformContext): void {
  const spec = call.getArguments()[0]
  if (!Node.isObjectLiteralExpression(spec)) {
    changes.todo(call, QUERY_SPEC_UNSEEN)
    return
  }
  const queryId = prop(spec, 'queryId')
  if (queryId !== undefined) {
    changes.push(renameKey(queryId, 'id'))
    changes.site()
  } else if (prop(spec, 'id') === undefined) {
    if (spec.getProperties().some((p) => Node.isSpreadAssignment(p))) {
      changes.todo(call, QUERY_SPEC_UNSEEN)
    } else {
      changes.push(prependProp(spec, `id: '${placeholderId(call, context)}'`))
      changes.todo(call, PLACEHOLDER_ID)
      changes.site()
    }
  }
  const crossTab = prop(spec, 'crossTab')
  const raw = crossTab === undefined ? undefined : valueText(crossTab)
  if (crossTab !== undefined && raw !== undefined) {
    // `'data'` was the only other 0.8 value, and 1.0 has one mode.
    changes.push(
      ...moveToMeta(
        spec,
        crossTab,
        `crossTab: ${raw === "'data'" || raw === '"data"' ? 'true' : raw}`,
      ),
    )
    changes.site()
  }
}

/** `persist` → `meta.persist`; `persist: false` is dropped, since off is the default in 1.0. */
function movePersist(spec: ObjectLiteralExpression, changes: FileChanges): boolean {
  const persist = prop(spec, 'persist')
  const raw = persist === undefined ? undefined : valueText(persist)
  if (persist === undefined || raw === undefined) return false
  if (raw === 'false') changes.push(removeProp(persist))
  else changes.push(...moveToMeta(spec, persist, `persist: ${raw}`))
  changes.site()
  return true
}

function defineMutationSpec(call: CallExpression, changes: FileChanges): void {
  const spec = call.getArguments()[0]
  if (!Node.isObjectLiteralExpression(spec)) {
    changes.todo(call, MUTATION_SPEC_UNSEEN)
    return
  }
  const mutationId = prop(spec, 'mutationId')
  if (mutationId === undefined) {
    // With an `id`, the spec is 1.0 already, where no `persist` means off.
    // With neither, it was invalid in 0.8 too.
    if (prop(spec, 'id') === undefined) changes.todo(call, MUTATION_ID)
    return
  }
  changes.push(renameKey(mutationId, 'id'))
  changes.site()
  const name = prop(spec, 'name')
  if (movePersist(spec, changes)) {
    if (name !== undefined) changes.push(removeProp(name))
  } else if (name !== undefined && prop(spec, 'meta') === undefined) {
    // 0.8 persisted a defined mutation by default; 1.0 asks for it. The new
    // `meta` takes the slot `name` leaves, so no edit lands next to its removal.
    changes.replaceNode(name, 'meta: { persist: true }')
    changes.site()
  } else {
    changes.push(...addMeta(spec, 'persist: true'))
    if (name !== undefined) changes.push(removeProp(name))
    changes.site()
  }
  reportHooks(spec, call, changes)
}

function reportHooks(
  spec: ObjectLiteralExpression,
  call: CallExpression,
  changes: FileChanges,
): void {
  if (spec.getProperties().some((p) => !Node.isSpreadAssignment(p) && HOOKS.has(p.getName()))) {
    changes.todo(call, DEFINITION_HOOKS)
  }
}

function createMutationSpec(call: CallExpression, changes: FileChanges): void {
  const spec = call.getArguments()[1]
  if (spec === undefined) return
  if (!Node.isObjectLiteralExpression(spec)) {
    // A `defineMutation` result is fine as it is: 1.0 has that overload.
    if (!isOldMutationDef(spec)) changes.todo(call, MUTATION_SPEC_UNSEEN)
    return
  }
  const props = spec.getProperties()
  const spreads = props.filter((p) => Node.isSpreadAssignment(p))
  const definition = spreads.find((s) => isOldMutationDef(s.getExpression()))
  if (definition !== undefined) {
    const rest = props.filter((p) => p !== definition)
    const onlyHooks =
      props[0] === definition &&
      rest.every((p) => !Node.isSpreadAssignment(p) && HOOKS.has(p.getName()))
    if (!onlyHooks) {
      changes.todo(call, SPREAD_DEFINITION)
      return
    }
    // `{ ...def, onSuccess }` → `def, { onSuccess }`
    const def = definition.getExpression().getText()
    const hooks = rest.map((p) => p.getText())
    const multiline = spec.getText().includes('\n')
    const text =
      hooks.length === 0
        ? def
        : multiline
          ? `${def}, {\n${hooks.map((h) => `  ${h},`).join('\n')}\n}`
          : `${def}, { ${hooks.join(', ')} }`
    changes.replaceNode(spec, text)
    changes.site()
    return
  }
  const mutationId = prop(spec, 'mutationId')
  const name = prop(spec, 'name')
  if (mutationId !== undefined) {
    changes.push(renameKey(mutationId, 'id'))
    if (name !== undefined) changes.push(removeProp(name))
    changes.site()
  } else if (name !== undefined) {
    // An inline spec's optional `id` is also its devtools label.
    changes.push(prop(spec, 'id') === undefined ? renameKey(name, 'id') : removeProp(name))
    changes.site()
  }
  movePersist(spec, changes)
}

/**
 * Identity is a required `id`, and plugin settings live under `meta`:
 * `queryId` → `id`, `crossTab` → `meta.crossTab`, `mutationId` → `id`,
 * `persist` → `meta.persist`. `name` is dropped. `defineMutation` stopped
 * persisting by default, so a definition without `persist` gains
 * `meta: { persist: true }` to keep its behaviour.
 */
export const identityMeta: Transform = {
  name: 'identity-meta',
  description:
    '`queryId`/`mutationId` → `id`, `crossTab`/`persist` → `meta`, `name` dropped; `createMutation(ctx, { ...def, hooks })` → `(ctx, def, hooks)`',
  run: (files, context) =>
    runPerFile('identity-meta', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const ref = refOf(call.getExpression())
        if (ref?.pkg !== 'core') continue
        if (ref.name === 'defineQuery' || ref.name === 'defineInfiniteQuery') {
          querySpec(call, changes, context)
        } else if (ref.name === 'defineMutation') {
          defineMutationSpec(call, changes)
        } else if (ref.name === 'createMutation') {
          createMutationSpec(call, changes)
        }
      }
    }),
}
