/** Vite serves `?raw` imports as strings; used by `tree-shaking.test.ts` to
 *  assert the import graph without pulling node types into this package. */
declare module '*?raw' {
  const content: string
  export default content
}

/** Vite's glob import, used by `tree-shaking.test.ts` to check that exactly one
 *  module holds a value edge to the query client. Declared here rather than
 *  pulling `vite/client` into the package's types. */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, string>
}
