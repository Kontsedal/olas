import { type CallExpression, Node, SyntaxKind } from 'ts-morph'
import { type FileChanges, runPerFile } from '../edits'
import type { Transform } from '../types'
import { localReferences, member } from '../util/ast'
import { importsOf, localNameOf, namespacePackage, refOf } from '../util/olas'

export const CLEAR_ALL =
  '`all: true` keeps what 0.8 did here, deleting every key the storage holds, which for localStorage is the whole origin: pass the `prefix` this app writes instead'
export const CLEAR_PREFIX =
  '`clearPersisted` throws on an empty or missing `prefix` in 1.0: check this value is never empty'

/** `localStorageAdapter` → `localStorageAdapter()`, unless it is already called or is a type. */
function callAdapter(ref: Node, changes: FileChanges): void {
  const parent = ref.getParentOrThrow()
  if (
    Node.isImportSpecifier(parent) ||
    Node.isExportSpecifier(parent) ||
    Node.isTypeQuery(parent)
  ) {
    return
  }
  if (Node.isCallExpression(parent) && parent.getExpression() === ref) return
  if (Node.isShorthandPropertyAssignment(parent)) {
    changes.replaceNode(parent, `${ref.getText()}: ${ref.getText()}()`)
  } else {
    changes.insert(ref.getEnd(), '()')
  }
  changes.site()
}

function clearPersisted(call: CallExpression, changes: FileChanges): void {
  const [storage, prefix, onError] = call.getArguments()
  if (prefix !== undefined && Node.isObjectLiteralExpression(prefix)) return
  const entries: string[] = []
  if (prefix === undefined || prefix.getText() === 'undefined') {
    entries.push('all: true')
    changes.todo(call, CLEAR_ALL)
  } else {
    entries.push(member('prefix', prefix.getText()))
    const literal =
      (Node.isStringLiteral(prefix) || Node.isNoSubstitutionTemplateLiteral(prefix)) &&
      prefix.getLiteralValue() !== ''
    if (!literal) changes.todo(call, CLEAR_PREFIX)
  }
  if (onError !== undefined) entries.push(member('onError', onError.getText()))
  const options = `{ ${entries.join(', ')} }`
  // `storage` stays as written, so a `localStorageAdapter` in it keeps its own edit.
  if (storage === undefined) changes.insert(call.getEnd() - 1, `undefined, ${options}`)
  else if (prefix === undefined) changes.insert(storage.getEnd(), `, ${options}`)
  else changes.replace(prefix.getStart(), (onError ?? prefix).getEnd(), options)
  changes.site()
}

/**
 * `localStorageAdapter` is a factory, like `indexedDbAdapter()`.
 * `clearPersisted(storage, prefix, onError)` takes an options object and
 * refuses to guess its scope.
 */
export const persist: Transform = {
  name: 'persist',
  description:
    '`localStorageAdapter` → `localStorageAdapter()`; `clearPersisted(s, prefix, onError)` → `clearPersisted(s, { prefix, onError })`',
  run: (files) =>
    runPerFile('persist', files, (file, changes) => {
      for (const spec of importsOf(file, 'persist', 'localStorageAdapter')) {
        for (const ref of localReferences(localNameOf(spec))) callAdapter(ref, changes)
      }
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (
          access.getName() === 'localStorageAdapter' &&
          namespacePackage(access.getExpression()) === 'persist'
        ) {
          callAdapter(access, changes)
        }
      }
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const ref = refOf(call.getExpression())
        if (ref?.pkg === 'persist' && ref.name === 'clearPersisted') clearPersisted(call, changes)
      }
    }),
}
