import { describe, expect, test } from 'vitest'
import { minifyCss, minifyInlineCss } from '../scripts/minify-css'
import { DEVTOOLS_CSS } from '../src/styles'

// The build minifies the inline stylesheet (tsdown.config.ts). A wrong regex
// there would ship a broken stylesheet to every consumer while every test,
// which imports the unminified source, stays green. So this pins it.

const rules = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((r) => r.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

describe('minifyCss', () => {
  test('keeps every rule, selector and declaration of the real stylesheet', () => {
    const min = minifyCss(DEVTOOLS_CSS)
    expect(min).not.toContain('/*')
    expect(min).not.toMatch(/\s{2}/)
    expect(min.length).toBeLessThan(DEVTOOLS_CSS.length * 0.9)
    expect((min.match(/\{/g) ?? []).length).toBe(
      (DEVTOOLS_CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{/g) ?? []).length,
    )
    const classes = (css: string) => new Set(css.match(/\.olas-devtools[a-z0-9-]*/g))
    expect(classes(min)).toEqual(classes(DEVTOOLS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')))
    // Same rules once whitespace is normalized the way the minifier does it.
    const normalize = (r: string) =>
      r
        .replace(/ ?([{};,>]) ?/g, '$1')
        .replace(/: /g, ':')
        .replace(/;$/, '')
    expect(rules(min).map(normalize)).toEqual(rules(DEVTOOLS_CSS).map(normalize))
  })

  test('keeps the spaces a selector or a value needs', () => {
    expect(
      minifyCss('.a :hover { width: calc(100% - 8px); font: 12px "Segoe UI", sans-serif; }'),
    ).toBe('.a :hover{width:calc(100% - 8px);font:12px "Segoe UI",sans-serif}')
    expect(minifyCss('.a > .b ,\n.c { x: 1 }')).toBe('.a>.b,.c{x:1}')
  })
})

describe('the minify-inline-css plugin', () => {
  const plugin = minifyInlineCss()

  test('rewrites the DEVTOOLS_CSS literal in src/styles.ts only', () => {
    const code = 'export const DEVTOOLS_CSS = `\n.a {\n  b: 1; /* why */\n}\n`\n'
    const out = plugin.transform(code, 'C:\\repo\\packages\\devtools\\src\\styles.ts')
    expect(out?.code).toBe('export const DEVTOOLS_CSS = `.a{b:1}`\n')
    // The map covers the rewrite, so the published sourcemap stays accurate.
    expect(out?.map.mappings).not.toBe('')
    expect(plugin.transform(code, '/repo/packages/devtools/src/other.ts')).toBeNull()
    expect(plugin.transform('export const X = 1\n', '/repo/src/styles.ts')).toBeNull()
  })
})
