import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils'

export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/Kontsedal/olas/tree/main/packages/eslint-plugin/docs/${name}.md`,
)

/** The callee's name for `foo(...)` and `ns.foo(...)`, else `undefined`. */
export function calleeName(call: TSESTree.CallExpression): string | undefined {
  const callee = call.callee
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name
  }
  return undefined
}

/** For `x.method(...)`: the object's source-level identity (`x`, `this.x`, `a.b`), else `undefined`. */
export function receiverText(
  call: TSESTree.CallExpression,
  source: { getText(node: TSESTree.Node): string },
): string | undefined {
  const callee = call.callee
  if (callee.type !== 'MemberExpression') return undefined
  return source.getText(callee.object)
}

export type AnyFunction =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression

export const isFunction = (node: TSESTree.Node | null | undefined): node is AnyFunction =>
  node != null &&
  (node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression')

/** The nearest enclosing function of `node`, or `undefined` at module scope. */
export function enclosingFunction(node: TSESTree.Node): AnyFunction | undefined {
  // `Program.parent` is `null` in ESLint 10 and `undefined` in earlier releases.
  let cursor: TSESTree.Node | null | undefined = node.parent
  while (cursor != null) {
    if (isFunction(cursor)) return cursor
    cursor = cursor.parent
  }
  return undefined
}

/** Every function that encloses `node`, innermost first. */
export function enclosingFunctions(node: TSESTree.Node): AnyFunction[] {
  const out: AnyFunction[] = []
  // `Program.parent` is `null` in ESLint 10 and `undefined` in earlier releases.
  let cursor: TSESTree.Node | null | undefined = node.parent
  while (cursor != null) {
    if (isFunction(cursor)) out.push(cursor)
    cursor = cursor.parent
  }
  return out
}

/** Whether `fn` is the factory argument of a `defineController(...)` call. */
export function isControllerFactory(fn: AnyFunction): boolean {
  const parent = fn.parent
  return (
    parent?.type === 'CallExpression' &&
    parent.arguments[0] === fn &&
    calleeName(parent) === 'defineController'
  )
}

/** The `onMutate` hook `fn` is the value of, when it is one (`onMutate: (v) => …` / `onMutate(v) {…}`). */
export function isOnMutateHook(fn: AnyFunction): boolean {
  const parent = fn.parent
  return (
    parent?.type === 'Property' &&
    parent.value === fn &&
    ((parent.key.type === 'Identifier' && parent.key.name === 'onMutate') ||
      (parent.key.type === 'Literal' && parent.key.value === 'onMutate'))
  )
}

/**
 * An Olas `setData(…, updater)` call: a method call whose last argument is a
 * function. That tells it from `DataTransfer.setData(format, data)` and other
 * unrelated methods of the same name.
 */
export function isOlasSetData(call: TSESTree.CallExpression): boolean {
  if (call.callee.type !== 'MemberExpression') return false
  const last = call.arguments[call.arguments.length - 1]
  return last !== undefined && isFunction(last as TSESTree.Node)
}
