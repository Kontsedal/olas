// @vitest-environment jsdom

/**
 * The SSR round trip, end to end, through real React: server
 * `renderToString` over a root whose cache the server filled, then client
 * `hydrateRoot` over a root seeded from `dehydrate()`.
 *
 * Everything else in this suite tests one half. `flows/ssr.md` describes the
 * whole path, `hydration-boundary.test.tsx` covers the boundary's lifecycle,
 * and the reader-ssr example asserts the cache hit without React. None of
 * them puts `renderToString` and `hydrateRoot` on the same markup, which is
 * where a hydration mismatch actually surfaces — React reports those through
 * `onRecoverableError` and then throws the server's DOM away.
 */

import type { Ctx, DehydratedState } from '@kontsedal/olas-core'
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { act } from '@testing-library/react'
import type { ReactElement } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, test } from 'vitest'
import { OlasProvider, use, useRoot } from '../src'

const ARTICLES = ['Rivers', 'Tides', 'Wakes']

let fetches = 0

/**
 * `staleTime: Infinity` so a hydrated entry is never refetched — that is
 * what makes "the client never called the fetcher" a claim about hydration
 * rather than about timing. Declared once at module scope so the server and
 * client roots share one registration (two `defineQuery` calls under one
 * `queryId` warn about a duplicate).
 */
const articlesQuery = defineQuery({
  id: 'ssr-hydration/articles',
  key: () => [],
  staleTime: Number.POSITIVE_INFINITY,
  fetcher: async () => {
    fetches += 1
    return ARTICLES
  },
})

/** Never settles, so the control's client render is pinned on `isLoading`. */
const pendingQuery = defineQuery({
  id: 'ssr-hydration/pending',
  key: () => [],
  staleTime: Number.POSITIVE_INFINITY,
  fetcher: () => new Promise<string[]>(() => {}),
})

const appFactory = (ctx: Ctx) => ({ articles: createQuery(ctx, articlesQuery) })
const appDef = defineController(appFactory)
type AppApi = ReturnType<typeof appFactory>

const pendingDef = defineController((ctx: Ctx) => ({
  articles: createQuery(ctx, pendingQuery),
}))

function Feed(): ReactElement {
  const api = useRoot<AppApi>()
  const data = use(api.articles.data)
  const isLoading = use(api.articles.isLoading)
  return (
    <ul data-testid="feed">
      {isLoading && <li>loading…</li>}
      {(data ?? []).map((title) => (
        <li key={title}>{title}</li>
      ))}
    </ul>
  )
}

/** Render `html` into a detached container and hydrate `element` over it. */
async function hydrateOver(
  html: string,
  element: ReactElement,
): Promise<{ container: HTMLDivElement; recoverable: unknown[]; cleanup: () => Promise<void> }> {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  const recoverable: unknown[] = []
  let reactRoot: ReturnType<typeof hydrateRoot> | undefined
  await act(async () => {
    reactRoot = hydrateRoot(container, element, {
      onRecoverableError: (err) => recoverable.push(err),
    })
  })
  return {
    container,
    recoverable,
    cleanup: async () => {
      await act(async () => {
        reactRoot?.unmount()
      })
      container.remove()
    },
  }
}

describe('renderToString → hydrateRoot', () => {
  beforeEach(() => {
    fetches = 0
  })

  test('hydrates the server markup with no mismatch and no second fetch', async () => {
    // --- Server ---------------------------------------------------------
    const server = createRoot(appDef, { queries: queryEngine(), deps: {} })
    await server.waitForIdle()
    const html = renderToString(
      <OlasProvider root={server}>
        <Feed />
      </OlasProvider>,
    )
    const state: DehydratedState = server.dehydrate()
    server.dispose()

    expect(fetches).toBe(1)
    expect(html).toContain('Rivers')
    expect(html).not.toContain('loading…')

    // --- Client ---------------------------------------------------------
    fetches = 0
    const client = createRoot(appDef, { queries: queryEngine(), deps: {}, hydrate: state })
    const { container, recoverable, cleanup } = await hydrateOver(
      html,
      <OlasProvider root={client}>
        <Feed />
      </OlasProvider>,
    )

    // React funnels a hydration mismatch here before discarding the server
    // DOM, so an empty list is the assertion that the two renders agreed.
    expect(recoverable).toEqual([])
    expect(container.querySelectorAll('li')).toHaveLength(3)
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(ARTICLES)
    // `hydrate` seeded the entry and `staleTime: Infinity` kept it fresh, so
    // subscribing on the client issued no request of its own.
    expect(fetches).toBe(0)

    await cleanup()
    client.dispose()
  })

  test('without the dehydrated state the same markup DOES mismatch', async () => {
    // The control. Without it the assertion above would pass just as well
    // against a hydration check that never fires.
    const server = createRoot(appDef, { queries: queryEngine(), deps: {} })
    await server.waitForIdle()
    const html = renderToString(
      <OlasProvider root={server}>
        <Feed />
      </OlasProvider>,
    )
    server.dispose()

    // A client root whose query never settles: it renders the loading row
    // where the server rendered three articles.
    const client = createRoot(pendingDef, { queries: queryEngine(), deps: {} })
    const { container, recoverable, cleanup } = await hydrateOver(
      html,
      <OlasProvider root={client}>
        <Feed />
      </OlasProvider>,
    )

    expect(recoverable.length).toBeGreaterThan(0)
    expect(container.textContent).toContain('loading…')

    await cleanup()
    client.dispose()
  })
})
