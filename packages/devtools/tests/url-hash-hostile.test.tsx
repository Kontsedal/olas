// @vitest-environment jsdom

import type { DebugEvent } from '@kontsedal/olas-core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'

// W15 security review, finding L7. With `urlHashKey` set, the panel reads its
// state from the URL hash. A crafted link used to crash the host app: a
// non-string filter reached `filter.trim()` during render, and with no error
// boundary React unmounted the whole tree. The parsed hash is now validated.

function fakeRoot() {
  return {
    debug: {
      subscribe: (_h: (e: DebugEvent) => void) => () => {},
      queryEntries: () => [],
    },
  }
}

/** Put `raw` into the hash the way the panel writes it (URLSearchParams + encodeURIComponent). */
const setHashValue = (raw: string) => {
  const params = new URLSearchParams()
  params.set('dt', encodeURIComponent(raw))
  window.history.replaceState(null, '', `#${params.toString()}`)
}
const selectedTab = () =>
  screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')

beforeEach(() => {
  window.history.replaceState(null, '', window.location.pathname)
  // A render error is reported through console.error before React rethrows it;
  // keep the output quiet so a failure reads as the assertion, not a stack dump.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a hostile urlHashKey hash falls back to defaults instead of crashing', () => {
  test.each([
    ['a non-string filter for the open tab', '{"tab":"cache","filters":{"cache":1}}', 'Cache'],
    ['an object filter', '{"filters":{"mutations":{"x":1}}}', 'Mutations'],
    ['an unknown tab', '{"tab":"evil","filters":{}}', 'Mutations'],
    ['a tab that is not a string', '{"tab":{"x":1}}', 'Mutations'],
    ['a prototype key as the tab', '{"tab":"__proto__"}', 'Mutations'],
    ['filters that are not an object', '{"filters":"abc"}', 'Mutations'],
    ['filters that are an array', '{"filters":[1,2]}', 'Mutations'],
    ['a JSON number', '42', 'Mutations'],
    ['JSON null', 'null', 'Mutations'],
    ['a JSON array', '[1,2]', 'Mutations'],
    ['a JSON string', '"cache"', 'Mutations'],
  ])('%s', (_label, raw, expectedTab) => {
    setHashValue(raw)
    expect(() =>
      render(<DevtoolsPanel root={fakeRoot()} urlHashKey="dt" defaultTab="mutations" />),
    ).not.toThrow()
    expect(screen.getByRole('tabpanel')).toBeTruthy()
    expect(selectedTab()?.getAttribute('title')).toBe(expectedTab)
    // Every filter that survived validation is a string, so the input shows ''.
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  })

  test('a valid string filter next to a hostile one is kept', () => {
    setHashValue('{"tab":"cache","filters":{"cache":"users","fields":7}}')
    render(<DevtoolsPanel root={fakeRoot()} urlHashKey="dt" defaultTab="mutations" />)
    expect(selectedTab()?.getAttribute('title')).toBe('Cache')
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('users')
  })
})
