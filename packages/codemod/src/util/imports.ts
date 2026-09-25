import {
  type ImportDeclaration,
  Node,
  type SourceFile,
  SymbolFlags,
  type Symbol as TsSymbol,
} from 'ts-morph'
import type { Edit } from '../edits'
import { appendMembers } from './ast'

function isValueImportOf(symbol: TsSymbol, module: string, name: string): boolean {
  return symbol.getDeclarations().some((decl) => {
    if (!Node.isImportSpecifier(decl) || decl.isTypeOnly()) return false
    const importDecl = decl.getImportDeclaration()
    return (
      !importDecl.isTypeOnly() &&
      importDecl.getModuleSpecifierValue() === module &&
      decl.getName() === name &&
      decl.getAliasNode() === undefined
    )
  })
}

/**
 * The binding named `name` that code at `at` sees, if any. Only asks the
 * checker when the name occurs in the file at all, since a scope listing
 * includes every global.
 */
export function visibleBinding(name: string, at: Node): TsSymbol | undefined {
  if (!new RegExp(`\\b${name}\\b`).test(at.getSourceFile().getFullText())) return undefined
  const checker = at.getProject().getTypeChecker()
  return checker
    .getSymbolsInScope(at, SymbolFlags.Value | SymbolFlags.Alias)
    .find((symbol) => symbol.getName() === name)
}

/**
 * Collects the named imports a transform needs in one file, and turns them
 * into one edit per module: appended to an existing value import of that
 * module, or a new import declaration after the last one.
 */
export class ImportAdder {
  private readonly wanted = new Map<string, Set<string>>()

  constructor(private readonly file: SourceFile) {}

  /**
   * Make `name` from `module` callable at `at`. Returns false when a
   * different binding of that name is visible there; the caller then leaves
   * the site alone and reports it.
   */
  need(module: string, name: string, at: Node): boolean {
    const seen = visibleBinding(name, at)
    if (seen !== undefined && !isValueImportOf(seen, module, name)) return false
    if (seen === undefined) {
      const names = this.wanted.get(module) ?? new Set<string>()
      names.add(name)
      this.wanted.set(module, names)
    }
    return true
  }

  edits(): Edit[] {
    const out: Edit[] = []
    const decls = this.file.getImportDeclarations()
    for (const [module, set] of this.wanted) {
      const names = [...set].sort()
      const target = decls.find(
        (d) =>
          d.getModuleSpecifierValue() === module &&
          !d.isTypeOnly() &&
          d.getNamespaceImport() === undefined &&
          d.getNamedImports().length > 0,
      )
      if (target !== undefined) {
        const list = target.getImportClauseOrThrow().getNamedBindingsOrThrow()
        out.push(appendMembers(list, target.getNamedImports(), names))
        continue
      }
      out.push(this.newDeclaration(decls, module, names))
    }
    return out
  }

  private newDeclaration(decls: ImportDeclaration[], module: string, names: string[]): Edit {
    const model = decls[0]
    const quote = model?.getModuleSpecifier().getText()[0] ?? "'"
    const semi = (model ?? this.file.getStatements()[0])?.getText().endsWith(';') ? ';' : ''
    const text = `import { ${names.join(', ')} } from ${quote}${module}${quote}${semi}`
    const lastImport = decls.at(-1)
    if (lastImport !== undefined) {
      return { start: lastImport.getEnd(), end: lastImport.getEnd(), text: `\n${text}` }
    }
    const statements = this.file.getStatements()
    // After a directive prologue such as 'use client', which must stay first.
    let lastDirective: Node | undefined
    for (const s of statements) {
      if (!Node.isExpressionStatement(s) || !Node.isStringLiteral(s.getExpression())) break
      lastDirective = s
    }
    if (lastDirective !== undefined) {
      return { start: lastDirective.getEnd(), end: lastDirective.getEnd(), text: `\n${text}` }
    }
    const first = statements[0]
    const at = first === undefined ? 0 : first.getStart(true)
    return { start: at, end: at, text: `${text}\n\n` }
  }
}
