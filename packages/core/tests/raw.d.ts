/** Vite serves `?raw` imports as strings; used by `tree-shaking.test.ts` to
 *  assert the import graph without pulling node types into this package. */
declare module '*?raw' {
  const content: string
  export default content
}
