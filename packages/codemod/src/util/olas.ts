import { type ImportSpecifier, Node, type SourceFile, type Symbol as TsSymbol } from 'ts-morph'

const PREFIX = '@kontsedal/olas-'
const IN_NODE_MODULES = /\/node_modules\/@kontsedal\/olas-([^/]+)\//

/**
 * `@kontsedal/olas-core` → `core`. A sub-path maps to its package:
 * `@kontsedal/olas-core/testing` → `core`, since no two entries of one
 * package export the same name.
 */
export function packageOf(specifier: string): string | undefined {
  if (!specifier.startsWith(PREFIX)) return undefined
  return specifier.slice(PREFIX.length).split('/')[0]
}

/** Which Olas package declares `decl`: an ambient `declare module`, or a file under node_modules. */
function packageOfDeclaration(decl: Node): string | undefined {
  for (const mod of decl.getAncestors()) {
    if (!Node.isModuleDeclaration(mod)) continue
    const name = mod.getNameNodes()
    if (!Array.isArray(name)) return packageOf(name.getLiteralValue())
  }
  return IN_NODE_MODULES.exec(decl.getSourceFile().getFilePath())?.[1]
}

/** An export of an Olas package, as a binding in user code refers to it. */
export type OlasRef = { readonly pkg: string; readonly name: string }

function refOfSymbol(symbol: TsSymbol): OlasRef | undefined {
  for (const decl of symbol.getDeclarations()) {
    if (!Node.isImportSpecifier(decl)) continue
    const pkg = packageOf(decl.getImportDeclaration().getModuleSpecifierValue())
    if (pkg !== undefined) return { pkg, name: decl.getName() }
  }
  // Not imported from an Olas specifier directly: follow the alias chain, for
  // a local module that re-exports an Olas package.
  if (!symbol.isAlias()) return undefined
  const target = symbol.getAliasedSymbol()
  for (const decl of target?.getDeclarations() ?? []) {
    const pkg = packageOfDeclaration(decl)
    if (pkg !== undefined) return { pkg, name: (target as TsSymbol).getName() }
  }
  return undefined
}

/** The Olas package an `import * as ns` binding names, when `node` is that binding. */
export function namespacePackage(node: Node): string | undefined {
  if (!Node.isIdentifier(node)) return undefined
  for (const decl of node.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isNamespaceImport(decl)) continue
    const importDecl = decl.getFirstAncestorOrThrow(Node.isImportDeclaration)
    return packageOf(importDecl.getModuleSpecifierValue())
  }
  return undefined
}

/**
 * The Olas export an expression names: an imported identifier (`use`), a
 * namespace member (`olas.use`), or a qualified type name (`olas.UseOptions`).
 */
export function refOf(node: Node): OlasRef | undefined {
  if (Node.isIdentifier(node)) {
    const symbol = node.getSymbol()
    return symbol === undefined ? undefined : refOfSymbol(symbol)
  }
  if (Node.isPropertyAccessExpression(node)) {
    const pkg = namespacePackage(node.getExpression())
    return pkg === undefined ? undefined : { pkg, name: node.getName() }
  }
  if (Node.isQualifiedName(node)) {
    const pkg = namespacePackage(node.getLeft())
    return pkg === undefined ? undefined : { pkg, name: node.getRight().getText() }
  }
  return undefined
}

/** True when `node` names the export `name` of the Olas package `pkg`. */
export function isRef(node: Node, pkg: string, name: string): boolean {
  const ref = refOf(node)
  return ref !== undefined && ref.pkg === pkg && ref.name === name
}

/** The `@kontsedal/olas-<pkg>` specifier for a package short name. */
export function specifierOf(pkg: string): string {
  return `${PREFIX}${pkg}`
}

/** The Olas export an import specifier brings in, directly or through a local re-export. */
export function specifierRef(spec: ImportSpecifier): OlasRef | undefined {
  const pkg = packageOf(spec.getImportDeclaration().getModuleSpecifierValue())
  if (pkg !== undefined) return { pkg, name: spec.getName() }
  return refOf(spec.getAliasNode() ?? spec.getNameNode())
}

/**
 * The file's import specifiers that bring in `pkg`'s export `name` under that
 * same name. A local module that re-exports it under another name is left
 * out, since renaming the importer would not match that module.
 */
export function importsOf(file: SourceFile, pkg: string, name: string): ImportSpecifier[] {
  const out: ImportSpecifier[] = []
  for (const decl of file.getImportDeclarations()) {
    for (const spec of decl.getNamedImports()) {
      if (spec.getName() !== name) continue
      const ref = specifierRef(spec)
      if (ref?.pkg === pkg && ref.name === name) out.push(spec)
    }
  }
  return out
}

/** The identifier that names an import specifier's binding in the file. */
export function localNameOf(spec: ImportSpecifier): Node {
  return spec.getAliasNode() ?? spec.getNameNode()
}
