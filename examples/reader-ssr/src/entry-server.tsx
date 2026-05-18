// Server entry. Builds the root, awaits the cache, renders to a string, and
// returns the rendered HTML plus the dehydrated state for the client to
// hydrate against.

import type { DehydratedState } from '@olas/core'
import { renderToString } from 'react-dom/server'
import { createFakeApi } from './api'
import { App } from './App'
import { createAppRoot } from './controller'

export async function render(_url: string): Promise<{ html: string; state: DehydratedState }> {
  const api = createFakeApi()
  const root = createAppRoot({
    api,
    // Deliberately omit `storage` — localStorage is not available server-side.
    // `usePersisted` handles this via `typeof localStorage === 'undefined'`.
  })

  // Subscribe at least once so `waitForIdle` sees the fetch.
  // Subscriptions are created during construction (ctx.use), so a microtask
  // tick is enough to schedule the first fetch.
  await Promise.resolve()
  await root.waitForIdle()

  const html = renderToString(<App root={root} />)
  const state = root.dehydrate()

  root.dispose()
  return { html, state }
}
