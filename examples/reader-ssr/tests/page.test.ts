// `renderPage` splices the app and its state into the template. Hostile text
// in either must not break the page.

import type { DehydratedState } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { renderPage } from '../src/page'

const TEMPLATE =
  '<div id="root"><!--app-html--></div>' +
  '<script>window.__OLAS_STATE__ = /*--olas-state--*/null/*--olas-state--*/;</script>'

const stateWith = (data: unknown): DehydratedState => ({
  version: 1,
  entries: [{ id: 'articles', key: [], data, lastUpdatedAt: 1 }],
})

/** Run the page's state script and return what it assigned. */
function stateOf(page: string): unknown {
  const body = page.slice(
    page.lastIndexOf('<script>') + '<script>'.length,
    page.lastIndexOf('</script>'),
  )
  const win: Record<string, unknown> = {}
  new Function('window', body)(win)
  return win.__OLAS_STATE__
}

describe('renderPage', () => {
  test('state containing </script> stays inside its script', () => {
    const state = stateWith({ title: '</script><img src=x onerror=alert(1)>' })
    const page = renderPage(TEMPLATE, '<p>app</p>', state)
    expect(page.match(/<\/script>/g)).toHaveLength(1)
    expect(page).not.toContain('<img')
    expect(stateOf(page)).toEqual(state)
  })

  test('replacement patterns in the rendered HTML stay literal', () => {
    // A string replacement reads `$'` as "the text after the match".
    const html = "<p>costs $' and $&</p>"
    const page = renderPage(TEMPLATE, html, stateWith(1))
    expect(page).toContain(html)
    expect(page.match(/<\/script>/g)).toHaveLength(1)
  })

  test('replacement patterns in the state stay literal', () => {
    const state = stateWith({ note: "$' and $`" })
    expect(stateOf(renderPage(TEMPLATE, '', state))).toEqual(state)
  })
})
