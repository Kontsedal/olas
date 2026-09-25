// Build-time minification of the panel's inline stylesheet.
//
// `src/styles.ts` ships its CSS as a template literal, and its comments carry
// the reasoning of `.wiki/decisions/ui-rules.md`. A JS minifier cannot touch
// the inside of a template literal, so without this every consumer's bundle
// would carry those comments and the indentation. The source keeps both;
// only the published string is minified.

import MagicString, { type SourceMap } from 'magic-string'

/**
 * Drop comments and collapse whitespace. Conservative on purpose: it never
 * removes the space BEFORE a `:`, because `.a :hover` and `.a:hover` are
 * different selectors, and it never touches `+` or `-`, which `calc()` needs.
 */
export function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{};,>]) ?/g, '$1')
    .replace(/: /g, ':')
    .replace(/;}/g, '}')
    .trim()
}

/**
 * A rolldown plugin that minifies the `DEVTOOLS_CSS` literal in `src/styles.ts`.
 * It returns a sourcemap for the rewrite; rolldown warns on a transform
 * without one, since the published `index.js.map` would be off after it.
 */
export function minifyInlineCss(): {
  name: string
  transform(code: string, id: string): { code: string; map: SourceMap } | null
} {
  return {
    name: 'olas-devtools:minify-inline-css',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/styles.ts')) return null
      const match = /(DEVTOOLS_CSS = `)([^`]*)`/.exec(code)
      if (!match) return null
      const [, open = '', css = ''] = match
      const min = minifyCss(css)
      if (min === css) return null
      const start = match.index + open.length
      const s = new MagicString(code).overwrite(start, start + css.length, min)
      return { code: s.toString(), map: s.generateMap({ hires: true, source: id }) }
    },
  }
}
