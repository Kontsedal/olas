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

/**
 * A node that leaves its operand's value alone: `x!`, `x as T`, `x satisfies T`,
 * `<T>x`, and the `ChainExpression` around an optional chain (`x?.y`).
 */
function isValueWrapper(
  node: TSESTree.Node,
): node is
  | TSESTree.ChainExpression
  | TSESTree.TSNonNullExpression
  | TSESTree.TSAsExpression
  | TSESTree.TSSatisfiesExpression
  | TSESTree.TSTypeAssertion {
  return (
    node.type === 'ChainExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion'
  )
}

/** The nearest ancestor of `node` that is not a value wrapper (`isValueWrapper`). */
export function valueParent(node: TSESTree.Node): TSESTree.Node | null | undefined {
  let parent: TSESTree.Node | null | undefined = node.parent
  while (parent != null && isValueWrapper(parent)) parent = parent.parent
  return parent
}

/**
 * An expression's source-level identity, with the value wrappers stripped at
 * every level: `todos!` and `(todos as Q)` are `todos`, `(this as any).q` and
 * `this.q!` are `this.q`, `a?.b` is `a.b`. The parser keeps no node for
 * parentheses, so they drop out on their own.
 */
function identityText(
  node: TSESTree.Node,
  source: { getText(node: TSESTree.Node): string },
): string {
  let inner = node
  while (isValueWrapper(inner)) inner = inner.expression
  if (inner.type !== 'MemberExpression') return source.getText(inner)
  const object = identityText(inner.object, source)
  return inner.computed
    ? `${object}[${identityText(inner.property, source)}]`
    : `${object}.${source.getText(inner.property)}`
}

/** For `x.method(...)`: the object's source-level identity (`x`, `this.x`, `a.b`), else `undefined`. */
export function receiverText(
  call: TSESTree.CallExpression,
  source: { getText(node: TSESTree.Node): string },
): string | undefined {
  const callee = call.callee
  if (callee.type !== 'MemberExpression') return undefined
  return identityText(callee.object, source)
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

/** Whether `property` is keyed `onMutate`, bare or quoted. */
export function isOnMutateKey(property: TSESTree.Property): boolean {
  const key = property.key
  return (
    (key.type === 'Identifier' && key.name === 'onMutate') ||
    (key.type === 'Literal' && key.value === 'onMutate')
  )
}

/** The `onMutate` hook `fn` is the value of, when it is one (`onMutate: (v) => …` / `onMutate(v) {…}`). */
export function isOnMutateHook(fn: AnyFunction): boolean {
  const parent = fn.parent
  return parent?.type === 'Property' && parent.value === fn && isOnMutateKey(parent)
}

/** The name a function is bound to: `function f() {}` or `const f = () => {}`. */
export function boundName(fn: AnyFunction): string | undefined {
  if (fn.type === 'FunctionDeclaration') return fn.id?.name
  const parent = fn.parent
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier')
    return parent.id.name
  return undefined
}

/**
 * Tracks the `onMutate` hooks of a file. A hook is a function written as an
 * `onMutate` value, or one whose bound name is used as an `onMutate` value
 * somewhere in the file (`onMutate: applyOptimistic`). The names are known
 * only once the whole file is read, so `isHook` belongs in `Program:exit`.
 */
export function onMutateHooks(): {
  Property(node: TSESTree.Property): void
  isHook(fn: AnyFunction): boolean
} {
  const names = new Set<string>()
  return {
    Property(node) {
      if (isOnMutateKey(node) && node.value.type === 'Identifier') names.add(node.value.name)
    },
    isHook(fn) {
      if (isOnMutateHook(fn)) return true
      const name = boundName(fn)
      return name !== undefined && names.has(name)
    },
  }
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
