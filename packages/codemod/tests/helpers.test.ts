import { type ExpressionStatement, Node, Project, SyntaxKind } from 'ts-morph'
import { describe, expect, it } from 'vitest'
import { FileChanges } from '../src/edits'
import { runCodemod, selectFiles } from '../src/run'
import type { Todo, Transform } from '../src/types'
import {
  addMeta,
  appendProp,
  functionLiteralOf,
  prependProp,
  prop,
  removeImportSpecifier,
  removeProp,
  valueText,
} from '../src/util/ast'
import { packageOf, refOf } from '../src/util/olas'
import { memoryFile, memoryProject } from './harness'

const CORE = '@kontsedal/olas-core'

/** Apply one set of edits to a file and return its text and TODOs. */
function edit(text: string, collect: (changes: FileChanges) => void, path?: string) {
  const file = memoryFile(text, path)
  const todos: Todo[] = []
  const changes = new FileChanges(file, 'test', todos)
  collect(changes)
  const sites = changes.apply()
  return { text: file.getFullText(), todos, sites }
}

describe('FileChanges', () => {
  it('applies nested and same-position edits in collection order', () => {
    const { text, sites } = edit('a(b)\n', (c) => {
      c.insert(1, '<')
      c.insert(1, '>')
      c.replace(2, 3, 'B')
      c.site()
    })
    expect(text).toBe('a<>(B)\n')
    expect(sites).toBe(1)
  })

  it('skips an edit that overlaps one already applied, and reports it', () => {
    const { text, todos } = edit('one\ntwo\n', (c) => {
      c.replace(4, 7, 'TWO')
      c.replace(2, 6, 'x')
    })
    expect(text).toBe('one\nTWO\n')
    expect(todos).toEqual([
      expect.objectContaining({
        line: 1,
        reason: 'two rewrites overlap here; finish this site by hand',
      }),
    ])
  })

  it('writes new lines in the line ending the file uses', () => {
    const file = new Project({ useInMemoryFileSystem: true }).createSourceFile(
      '/crlf.ts',
      'const a = 1\r\nconst b = 2\r\n',
    )
    const changes = new FileChanges(file, 'test', [])
    changes.insert(file.getFullText().indexOf('const b'), 'const x = 0\n')
    changes.apply()
    expect(file.getFullText()).toBe('const a = 1\r\nconst x = 0\r\nconst b = 2\r\n')
  })

  it('leaves a file with no edits untouched', () => {
    expect(edit('x\n', () => {}).text).toBe('x\n')
  })
})

describe('ImportAdder', () => {
  const need = (text: string, name = 'createField', path?: string) =>
    edit(
      text,
      (c) => {
        const at = c.file.getStatements().at(-1) ?? c.file
        expect(c.imports.need(CORE, name, at)).toBe(true)
      },
      path,
    ).text

  it('adds a declaration after a type-only import, in its quotes and semicolons', () => {
    expect(need('import type { Ctx } from "@kontsedal/olas-core";\nlet c: Ctx;\n')).toBe(
      'import type { Ctx } from "@kontsedal/olas-core";\nimport { createField } from "@kontsedal/olas-core";\nlet c: Ctx;\n',
    )
  })

  it('appends to a multi-line import one name per line', () => {
    expect(need("import {\n  signal,\n} from '@kontsedal/olas-core'\nsignal\n")).toBe(
      "import {\n  signal,\n  createField,\n} from '@kontsedal/olas-core'\nsignal\n",
    )
    expect(need("import {\n  signal\n} from '@kontsedal/olas-core'\nsignal\n")).toBe(
      "import {\n  signal,\n  createField\n} from '@kontsedal/olas-core'\nsignal\n",
    )
  })

  it('adds a declaration beside a namespace import', () => {
    expect(need("import * as olas from '@kontsedal/olas-core'\nolas\n")).toBe(
      "import * as olas from '@kontsedal/olas-core'\nimport { createField } from '@kontsedal/olas-core'\nolas\n",
    )
  })

  it('adds a declaration after a directive prologue', () => {
    expect(need("'use client'\nexport const a = 1\n")).toBe(
      "'use client'\nimport { createField } from '@kontsedal/olas-core'\nexport const a = 1\n",
    )
  })

  it('adds a declaration above the first statement and its doc comment', () => {
    expect(need('/** Doc. */\nexport const a = 1;\n')).toBe(
      "import { createField } from '@kontsedal/olas-core';\n\n/** Doc. */\nexport const a = 1;\n",
    )
    expect(need('')).toBe("import { createField } from '@kontsedal/olas-core'\n\n")
  })

  it('reuses an existing import and refuses a name another binding holds', () => {
    const text = "import { createField } from '@kontsedal/olas-core'\ncreateField\n"
    expect(need(text)).toBe(text)
    edit('const createField = 1\ncreateField\n', (c) => {
      expect(c.imports.need(CORE, 'createField', c.file.getStatements()[1] as Node)).toBe(false)
    })
    edit(
      "import { createField as cf } from '@kontsedal/olas-core'\nconst createField = cf\n",
      (c) => {
        expect(c.imports.need(CORE, 'createField', c.file.getStatements()[1] as Node)).toBe(false)
      },
    )
  })
})

describe('refOf', () => {
  it('names the package of an import, a namespace member and a qualified type name', () => {
    const file = memoryFile(
      [
        "import { use } from '@kontsedal/olas-react'",
        "import * as core from '@kontsedal/olas-core'",
        'const local = 1',
        'export const a = [use, core.signal, local, (0, use), local.toFixed]',
        'export type T = core.UseOptions<[]> | Local.Thing',
        'declare namespace Local { type Thing = 1 }',
      ].join('\n'),
    )
    const ids = file.getDescendantsOfKind(SyntaxKind.Identifier)
    const use = ids.find(
      (i) => i.getText() === 'use' && Node.isArrayLiteralExpression(i.getParent()),
    )
    expect(refOf(use as Node)).toEqual({ pkg: 'react', name: 'use' })
    const [signal, fixed] = file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    expect(refOf(signal as Node)).toEqual({ pkg: 'core', name: 'signal' })
    expect(refOf(fixed as Node)).toBeUndefined()
    const [useOptions, thing] = file.getDescendantsOfKind(SyntaxKind.QualifiedName)
    expect(refOf(useOptions as Node)).toEqual({ pkg: 'core', name: 'UseOptions' })
    expect(refOf(thing as Node)).toBeUndefined()
    expect(refOf(ids.find((i) => i.getText() === 'local') as Node)).toBeUndefined()
    expect(
      refOf(file.getFirstDescendantByKindOrThrow(SyntaxKind.ParenthesizedExpression)),
    ).toBeUndefined()
  })

  it('follows a local re-export to a package under node_modules', () => {
    const project = new Project({ useInMemoryFileSystem: true })
    project.createSourceFile(
      '/node_modules/@kontsedal/olas-react/index.d.ts',
      'export declare function use<T>(s: { value: T }): T\n',
    )
    project.createSourceFile('/src/olas.ts', "export { use } from '@kontsedal/olas-react'\n")
    const file = project.createSourceFile('/src/view.ts', "import { use } from './olas'\nuse\n")
    const ref = file.getStatements()[1] as ExpressionStatement
    expect(refOf(ref.getExpression())).toEqual({ pkg: 'react', name: 'use' })
    const unresolved = project.createSourceFile(
      '/src/other.ts',
      "import { use } from './nowhere'\nuse\n",
    )
    const other = unresolved.getStatements()[1] as ExpressionStatement
    expect(refOf(other.getExpression())).toBeUndefined()
  })

  it('maps a specifier to its package', () => {
    expect(packageOf('@kontsedal/olas-core/testing')).toBe('core')
    expect(packageOf('react')).toBeUndefined()
  })
})

describe('AST helpers', () => {
  const first = (text: string) =>
    memoryFile(text).getFirstDescendantByKindOrThrow(SyntaxKind.ObjectLiteralExpression)

  it('removes a property with the right comma', () => {
    const only = first('export const o = { a: 1 }\n')
    expect(removeProp(prop(only, 'a') as Node)).toMatchObject({ text: '' })
    const apply = (text: string, name: string) =>
      edit(text, (c) => {
        const obj = c.file.getFirstDescendantByKindOrThrow(SyntaxKind.ObjectLiteralExpression)
        c.push(removeProp(prop(obj, name) as Node))
      }).text
    expect(apply('const o = { a: 1 }\n', 'a')).toBe('const o = {}\n')
    expect(apply('const o = { a: 1, b: 2 }\n', 'b')).toBe('const o = { a: 1 }\n')
    expect(apply('const o = { a: 1, b: 2 }\n', 'a')).toBe('const o = { b: 2 }\n')
  })

  it('appends and prepends in the layout of the literal', () => {
    const apply = (text: string, how: 'append' | 'prepend') =>
      edit(text, (c) => {
        const obj = c.file.getFirstDescendantByKindOrThrow(SyntaxKind.ObjectLiteralExpression)
        c.push(how === 'append' ? appendProp(obj, 'x: 0') : prependProp(obj, 'x: 0'))
      }).text
    expect(apply('const o = {}\n', 'append')).toBe('const o = { x: 0 }\n')
    expect(apply('const o = {\n  a: 1\n}\n', 'append')).toBe('const o = {\n  a: 1,\n  x: 0\n}\n')
    expect(apply('const o = {}\n', 'prepend')).toBe('const o = { x: 0 }\n')
    expect(apply('const o = { a: 1,\n  b: 2 }\n', 'prepend')).toBe(
      'const o = { x: 0, a: 1,\n  b: 2 }\n',
    )
  })

  it('merges into a meta value that is not a literal', () => {
    const text = edit('const o = { meta: shared }\n', (c) => {
      const obj = c.file.getFirstDescendantByKindOrThrow(SyntaxKind.ObjectLiteralExpression)
      c.push(...addMeta(obj, 'persist: true'))
    }).text
    expect(text).toBe('const o = { meta: { ...shared, persist: true } }\n')
  })

  it('reads values, and finds function literals', () => {
    const obj = first('const o = { m() {}, s, p: 1, f: () => 1 }\n')
    expect(valueText(prop(obj, 'm') as never)).toBeUndefined()
    expect(valueText(prop(obj, 's') as never)).toBe('s')
    expect(functionLiteralOf(prop(obj, 's'))).toBeUndefined()
    expect(functionLiteralOf(prop(obj, 'p'))).toBeUndefined()
    expect(functionLiteralOf(undefined)).toBeUndefined()
    expect(functionLiteralOf(prop(obj, 'f'))?.getKind()).toBe(SyntaxKind.ArrowFunction)
  })

  it('removes one import specifier, or its whole declaration', () => {
    const apply = (text: string) =>
      edit(text, (c) => {
        const spec = c.file.getFirstDescendantByKindOrThrow(SyntaxKind.ImportSpecifier)
        c.push(removeImportSpecifier(spec))
      }).text
    expect(apply("import React, { a } from 'r'\nReact\n")).toBe("import React from 'r'\nReact\n")
    expect(apply("import { a } from 'r'\nx\n")).toBe('x\n')
    expect(apply("import { a, b } from 'r'\nx\n")).toBe("import { b } from 'r'\nx\n")
  })
})

describe('runCodemod', () => {
  const noisy: Transform = {
    name: 'noisy',
    description: 'reports the same site twice, across two files',
    run: (files) => {
      const todos = files.flatMap((file) => {
        const t = { file: file.getFilePath(), line: 1, transform: 'noisy', reason: 'r' }
        return [t, t, { ...t, line: 0 }]
      })
      return { changed: 0, todos }
    },
  }

  it('drops duplicate TODOs and sorts them by file and line', () => {
    const project = memoryProject()
    const b = project.createSourceFile('/src/b.ts', 'b\n')
    const a = project.createSourceFile('/src/a.ts', 'a\n')
    const result = runCodemod([b, a], { rootDir: '/', transforms: [noisy] })
    expect(result.todos.map((t) => `${t.file}:${t.line}`)).toEqual([
      '/src/a.ts:0',
      '/src/a.ts:1',
      '/src/b.ts:0',
      '/src/b.ts:1',
    ])
    expect(result.changed).toEqual([])
    expect(result.summaries).toEqual([
      { name: 'noisy', description: noisy.description, files: 0, sites: 0, todos: 6 },
    ])
  })

  it('selects the project sources, under the given paths', () => {
    const project = memoryProject()
    project.createSourceFile('/src/a.ts', '')
    project.createSourceFile('/src/deep/b.ts', '')
    project.createSourceFile('/lib/c.ts', '')
    project.createSourceFile('/node_modules/x/index.ts', '')
    project.createSourceFile('/dist/d.ts', '')
    const paths = (p?: string[]) =>
      selectFiles(project, p)
        .map((f) => f.getFilePath())
        .sort()
    expect(paths()).toEqual(['/lib/c.ts', '/src/a.ts', '/src/deep/b.ts'])
    expect(paths(['/src/deep', '/lib/c.ts'])).toEqual(['/lib/c.ts', '/src/deep/b.ts'])
    expect(paths(['/sr'])).toEqual([])
  })
})
