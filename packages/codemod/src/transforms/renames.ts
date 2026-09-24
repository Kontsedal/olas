import { Node, SyntaxKind } from 'ts-morph'
import { type FileChanges, runPerFile } from '../edits'
import type { Transform } from '../types'
import { localReferences, prop, removeImportSpecifier, renameKey } from '../util/ast'
import { visibleBinding } from '../util/imports'
import { localNameOf, namespacePackage, packageOf, specifierRef } from '../util/olas'

export type Rename = { readonly pkg: string; readonly from: string; readonly to: string }

/** Every export 1.0 renames without changing what it does. */
export const RENAMES: readonly Rename[] = [
  { pkg: 'react', from: 'use', to: 'useValue' },
  { pkg: 'react', from: 'KeepAlive', to: 'SuspendOnUnmount' },
  { pkg: 'persist', from: 'usePersisted', to: 'createPersisted' },
  { pkg: 'realtime', from: 'useRealtimePatcher', to: 'createRealtimePatcher' },
  { pkg: 'realtime', from: 'useLiveStream', to: 'createLiveStream' },
  { pkg: 'realtime', from: 'useRealtimeConnection', to: 'createConnectionState' },
  { pkg: 'zod', from: 'formFromZod', to: 'createZodForm' },
  { pkg: 'zod', from: 'FormFromZodOptions', to: 'ZodFormOptions' },
  { pkg: 'core', from: 'selection', to: 'createSelection' },
  { pkg: 'core', from: 'DefaultQueryOptions', to: 'QueryDefaults' },
  { pkg: 'core', from: 'UseOptions', to: 'QuerySubscriptionOptions' },
]

export const ZOD_INITIALS =
  '`createZodForm` takes `initial`, not `initials`: rename it in the options this passes'

const OLD_NAMES = new Set(RENAMES.map((r) => r.from))

const ruleFor = (pkg: string | undefined, name: string): Rename | undefined =>
  RENAMES.find((r) => r.pkg === pkg && r.from === name)

/** A reference takes the new name; a shorthand property keeps its key. */
function renameReference(ref: Node, rule: Rename, changes: FileChanges): void {
  const parent = ref.getParent()
  if (parent !== undefined && Node.isShorthandPropertyAssignment(parent)) {
    changes.replaceNode(parent, `${rule.from}: ${rule.to}`)
  } else {
    changes.replaceNode(ref, rule.to)
  }
}

/** `formFromZod(ctx, schema, { initials })` → `createZodForm(ctx, schema, { initial })`. */
function zodOptions(callee: Node, changes: FileChanges): void {
  const call = callee.getParent()
  if (call === undefined || !Node.isCallExpression(call) || call.getExpression() !== callee) return
  const options = call.getArguments()[2]
  if (options === undefined) return
  if (!Node.isObjectLiteralExpression(options)) {
    if (options.getType().getProperty('initials') !== undefined) changes.todo(options, ZOD_INITIALS)
    return
  }
  const initials = prop(options, 'initials')
  if (initials === undefined) return
  changes.push(renameKey(initials, 'initial'))
  changes.site()
}

function visitImports(changes: FileChanges): void {
  const imports = changes.file.getImportDeclarations()
  for (const decl of imports) {
    for (const spec of decl.getNamedImports()) {
      if (!OLD_NAMES.has(spec.getName())) continue
      const ref = specifierRef(spec)
      const rule = ruleFor(ref?.pkg, spec.getName())
      if (rule === undefined || ref?.name !== rule.from) continue
      const refs = localReferences(localNameOf(spec))
      if (rule.from === 'formFromZod') for (const r of refs) zodOptions(r, changes)
      changes.site()
      if (spec.getAliasNode() !== undefined) {
        // `import { use as read }`: only the imported name changes.
        changes.replaceNode(spec.getNameNode(), rule.to)
        continue
      }
      const twin = imports
        .filter((d) => d.getModuleSpecifierValue() === decl.getModuleSpecifierValue())
        .flatMap((d) => d.getNamedImports())
        .find((s) => s.getName() === rule.to && s.getAliasNode() === undefined)
      if (twin !== undefined) {
        // Both names imported already: drop the old one and repoint its uses.
        changes.push(removeImportSpecifier(spec))
        for (const r of refs) renameReference(r, rule, changes)
      } else if ([spec, ...refs].some((at) => visibleBinding(rule.to, at) !== undefined)) {
        // The new name is taken in this file: keep the old one as a local alias.
        changes.replaceNode(spec.getNameNode(), `${rule.to} as ${rule.from}`)
      } else {
        changes.replaceNode(spec.getNameNode(), rule.to)
        for (const r of refs) renameReference(r, rule, changes)
      }
    }
  }
}

/**
 * Renames of exports whose behaviour is unchanged: the React `use` →
 * `useValue` and `KeepAlive` → `SuspendOnUnmount`, the `use*` composables →
 * `create*`, `formFromZod` → `createZodForm`, `selection` →
 * `createSelection`, and two type names. A reference follows its import
 * binding, so a local that shadows the import is left alone.
 */
export const renames: Transform = {
  name: 'renames',
  description:
    '`use` → `useValue`, `KeepAlive` → `SuspendOnUnmount`, `usePersisted` → `createPersisted`, the realtime `use*` → `create*`, `formFromZod` → `createZodForm`, `selection` → `createSelection`, and two type names',
  run: (files) =>
    runPerFile('renames', files, (file, changes) => {
      visitImports(changes)
      for (const decl of file.getExportDeclarations()) {
        const pkg = packageOf(decl.getModuleSpecifierValue() ?? '')
        for (const spec of decl.getNamedExports()) {
          const rule = ruleFor(pkg, spec.getName())
          if (rule === undefined) continue
          changes.replaceNode(spec.getNameNode(), rule.to)
          changes.site()
        }
      }
      // `olas.use(...)` and `olas.UseOptions` through `import * as olas`.
      const member = (node: Node, left: Node, name: Node): void => {
        if (!OLD_NAMES.has(name.getText())) return
        const rule = ruleFor(namespacePackage(left), name.getText())
        if (rule === undefined) return
        changes.replaceNode(name, rule.to)
        if (rule.from === 'formFromZod') zodOptions(node, changes)
        changes.site()
      }
      for (const n of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        member(n, n.getExpression(), n.getNameNode())
      }
      for (const n of file.getDescendantsOfKind(SyntaxKind.QualifiedName)) {
        member(n, n.getLeft(), n.getRight())
      }
    }),
}
