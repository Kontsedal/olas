import {
  type ArrowFunction,
  type Expression,
  type FunctionExpression,
  type ImportSpecifier,
  type MethodDeclaration,
  Node,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type ShorthandPropertyAssignment,
  SyntaxKind,
  type Symbol as TsSymbol,
} from 'ts-morph'
import type { Edit } from '../edits'

/** A named member of an object literal. */
export type Prop = PropertyAssignment | ShorthandPropertyAssignment | MethodDeclaration

export function prop(obj: ObjectLiteralExpression, name: string): Prop | undefined {
  for (const p of obj.getProperties()) {
    if (
      (Node.isPropertyAssignment(p) ||
        Node.isShorthandPropertyAssignment(p) ||
        Node.isMethodDeclaration(p)) &&
      p.getName() === name
    ) {
      return p
    }
  }
  return undefined
}

/** `name: value` as object-literal text, shortened to `name` when the value is that name. */
export function member(name: string, value: string): string {
  return value === name ? name : `${name}: ${value}`
}

/** The value of a property as source text; a method has none. */
export function valueText(p: Prop): string | undefined {
  if (Node.isPropertyAssignment(p)) return p.getInitializerOrThrow().getText()
  if (Node.isShorthandPropertyAssignment(p)) return p.getName()
  return undefined
}

/** The object literal a property's value is, if it is one. */
export function literalValue(p: Prop | undefined): ObjectLiteralExpression | undefined {
  if (p === undefined || !Node.isPropertyAssignment(p)) return undefined
  const init = p.getInitializer()
  return Node.isObjectLiteralExpression(init) ? init : undefined
}

/** Position of the first non-whitespace character from `pos`, stepping by `step`. */
function skipSpace(text: string, pos: number, step: 1 | -1): number {
  let i = pos
  while (i >= 0 && i < text.length && /\s/.test(text[i] as string)) i += step
  return i
}

/** The position just past a comma that follows `pos` across whitespace, if one does. */
export function commaAfter(text: string, pos: number): number | undefined {
  const i = skipSpace(text, pos, 1)
  return text[i] === ',' ? i + 1 : undefined
}

/** Remove a property with one of its commas, so no stray comma is left. */
export function removeProp(p: Node): Edit {
  const text = p.getSourceFile().getFullText()
  const trailing = commaAfter(text, p.getEnd())
  if (trailing !== undefined) return { start: p.getFullStart(), end: trailing, text: '' }
  const before = skipSpace(text, p.getFullStart() - 1, -1)
  if (text[before] === ',') return { start: before, end: p.getEnd(), text: '' }
  // The only member: `{ a: 1 }` → `{}`.
  return { start: p.getFullStart(), end: skipSpace(text, p.getEnd(), 1), text: '' }
}

/** Rename a property's key, keeping its value. A shorthand gains an explicit value. */
export function renameKey(p: Prop, to: string): Edit {
  if (Node.isShorthandPropertyAssignment(p)) {
    return { start: p.getStart(), end: p.getEnd(), text: `${to}: ${p.getName()}` }
  }
  const name = p.getNameNode()
  return { start: name.getStart(), end: name.getEnd(), text: to }
}

function indentOf(node: Node): string {
  return ' '.repeat(node.getStart() - node.getStartLinePos())
}

/**
 * Add `texts` as the last members of a bracketed list (an object or array
 * literal, or named imports), in its layout: on the same line when the list
 * is on one line, one per line with the last member's indent when it is not.
 */
export function appendMembers(
  list: Node,
  members: readonly Node[],
  texts: readonly string[],
): Edit {
  const last = members.at(-1)
  if (last === undefined) {
    const joined = texts.join(', ')
    const inner = Node.isArrayLiteralExpression(list) ? joined : ` ${joined} `
    return { start: list.getStart() + 1, end: list.getEnd() - 1, text: inner }
  }
  if (!list.getText().includes('\n')) {
    return { start: last.getEnd(), end: last.getEnd(), text: `, ${texts.join(', ')}` }
  }
  const indent = indentOf(last)
  const joined = texts.join(`,\n${indent}`)
  const comma = commaAfter(list.getSourceFile().getFullText(), last.getEnd())
  if (comma !== undefined) return { start: comma, end: comma, text: `\n${indent}${joined},` }
  return { start: last.getEnd(), end: last.getEnd(), text: `,\n${indent}${joined}` }
}

/** Add `text` as the last member of an object or array literal, in its layout. */
export function appendMember(list: Node, members: readonly Node[], text: string): Edit {
  return appendMembers(list, members, [text])
}

export function appendProp(obj: ObjectLiteralExpression, text: string): Edit {
  return appendMember(obj, obj.getProperties(), text)
}

/** Add `entry` to the `meta` object of a spec, creating `meta` when there is none. */
export function addMeta(obj: ObjectLiteralExpression, entry: string): Edit[] {
  const meta = prop(obj, 'meta')
  const literal = literalValue(meta)
  if (literal !== undefined) return [appendProp(literal, entry)]
  if (meta !== undefined && Node.isPropertyAssignment(meta)) {
    const init = meta.getInitializerOrThrow()
    return [
      { start: init.getStart(), end: init.getEnd(), text: `{ ...${init.getText()}, ${entry} }` },
    ]
  }
  return [appendProp(obj, `meta: { ${entry} }`)]
}

/**
 * Move a property under `meta`. With no `meta` to merge into, the property is
 * replaced in place, so the edit cannot overlap a neighbour's.
 */
export function moveToMeta(obj: ObjectLiteralExpression, p: Prop, entry: string): Edit[] {
  if (prop(obj, 'meta') !== undefined) return [removeProp(p), ...addMeta(obj, entry)]
  return [{ start: p.getStart(), end: p.getEnd(), text: `meta: { ${entry} }` }]
}

/** Insert `text` as the first member of an object literal. */
export function prependProp(obj: ObjectLiteralExpression, text: string): Edit {
  const first = obj.getProperties()[0]
  if (first === undefined) return appendProp(obj, text)
  if (obj.getText().includes('\n') && first.getStartLineNumber() !== obj.getStartLineNumber()) {
    return { start: first.getStart(), end: first.getStart(), text: `${text},\n${indentOf(first)}` }
  }
  return { start: first.getStart(), end: first.getStart(), text: `${text}, ` }
}

/** The first ancestor that is not a parenthesized expression. */
export function parentSkippingParens(node: Node): Node | undefined {
  let parent = node.getParent()
  while (parent !== undefined && Node.isParenthesizedExpression(parent)) parent = parent.getParent()
  return parent
}

const MEMBER_BASES = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.CallExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.ThisKeyword,
])

/** `expr.<member>` as text, parenthesizing `expr` when precedence needs it. */
export function accessText(expr: Node, member: string): string {
  return MEMBER_BASES.has(expr.getKind())
    ? `${expr.getText()}.${member}`
    : `(${expr.getText()}).${member}`
}

/** Edits appending `.<member>` to an expression, parenthesizing it when precedence needs it. */
export function appendAccess(expr: Expression | Node, member: string): Edit[] {
  if (MEMBER_BASES.has(expr.getKind())) {
    return [{ start: expr.getEnd(), end: expr.getEnd(), text: `.${member}` }]
  }
  return [
    { start: expr.getStart(), end: expr.getStart(), text: '(' },
    { start: expr.getEnd(), end: expr.getEnd(), text: `).${member}` },
  ]
}

/** Remove one import specifier, or the whole declaration when it is the only one. */
export function removeImportSpecifier(spec: ImportSpecifier): Edit {
  const decl = spec.getImportDeclaration()
  if (decl.getNamedImports().length > 1) return removeProp(spec)
  const clause = decl.getImportClauseOrThrow()
  const defaultImport = clause.getDefaultImport()
  if (defaultImport !== undefined) {
    // `import React, { a } from 'r'` → `import React from 'r'`
    return { start: defaultImport.getEnd(), end: clause.getEnd(), text: '' }
  }
  const text = decl.getSourceFile().getFullText()
  const newline = /^\r?\n/.exec(text.slice(decl.getEnd(), decl.getEnd() + 2))
  return { start: decl.getStart(), end: decl.getEnd() + (newline?.[0].length ?? 0), text: '' }
}

/**
 * How a call's result is consumed:
 * - `unused`: a statement of its own, or under `void`;
 * - `awaited`: `await call()` as a statement, which waits but drops the value;
 * - `returned`: the expression body of an arrow function;
 * - `used`: anything else (assigned, returned from a block, passed on, chained).
 */
export function resultUse(call: Node): 'unused' | 'awaited' | 'returned' | 'used' {
  let awaited = false
  let parent = call.getParent()
  while (
    parent !== undefined &&
    (Node.isParenthesizedExpression(parent) || Node.isAwaitExpression(parent))
  ) {
    if (Node.isAwaitExpression(parent)) awaited = true
    parent = parent.getParent()
  }
  if (parent === undefined || Node.isExpressionStatement(parent) || Node.isVoidExpression(parent)) {
    return awaited ? 'awaited' : 'unused'
  }
  if (Node.isArrowFunction(parent)) return 'returned'
  return 'used'
}

/** True when `node` is the body of an arrow passed as a JSX attribute, `onClick={() => …}`. */
export function isJsxHandlerBody(node: Node): boolean {
  const arrow = parentSkippingParens(node)
  const container = arrow?.getParent()
  return (
    arrow !== undefined &&
    Node.isArrowFunction(arrow) &&
    container !== undefined &&
    Node.isJsxExpression(container) &&
    Node.isJsxAttribute(container.getParent())
  )
}

/** Every other identifier in the file bound to the same symbol as `name`. */
export function localReferences(name: Node): Node[] {
  const symbol = name.getSymbol()
  if (symbol === undefined) return []
  const text = name.getText()
  return name
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((id) => id !== name && id.getText() === text && sameBinding(id, symbol))
}

function sameBinding(id: Node, symbol: TsSymbol): boolean {
  const parent = id.getParent()
  if (parent !== undefined && Node.isShorthandPropertyAssignment(parent)) {
    const checker = id.getProject().getTypeChecker()
    return checker.getShorthandAssignmentValueSymbol(parent) === symbol
  }
  return id.getSymbol() === symbol
}

export type FunctionLiteral = ArrowFunction | FunctionExpression | MethodDeclaration

/** A function written in place: an arrow, a function expression, or a method. */
export function functionLiteralOf(node: Node | undefined): FunctionLiteral | undefined {
  if (node === undefined) return undefined
  if (
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isMethodDeclaration(node)
  ) {
    return node
  }
  if (Node.isPropertyAssignment(node)) return functionLiteralOf(node.getInitializer())
  return undefined
}
