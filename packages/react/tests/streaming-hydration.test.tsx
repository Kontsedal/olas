// @vitest-environment jsdom

/**
 * Streaming SSR end to end, through real React: the server renders with
 * `renderToReadableStream` through `createStreamingTransform`, the client
 * loads that HTML, runs its inline scripts in document order the way a parser
 * would (the flushed batches, the bootstrap, React's `$RC` reveals), and
 * hydrates over it with `onRecoverableError` watching for a mismatch.
 *
 * React writes its stream in fixed-size views (2,048 bytes in the browser
 * build, 4,096 in the Node one), so the pages here are far larger than a view:
 * a chunk boundary lands inside a list item's text, in the shell and in a
 * completed `<Suspense>` segment.
 */

import {
  type Ctx,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
  type Root,
} from '@kontsedal/olas-core'
import { act } from '@testing-library/react'
import { type ReactElement, Suspense } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToReadableStream as renderInBrowserBuild } from 'react-dom/server.browser'
import { renderToReadableStream as renderInNodeBuild } from 'react-dom/server.node'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createStreamingHydrator,
  createStreamingTransform,
  HydrationBoundary,
  OLAS_BOOTSTRAP_SCRIPT,
  OlasProvider,
  STREAMING_GLOBAL,
  useRoot,
  useSuspenseQuery,
  useValue,
} from '../src'

const ARTICLES = Array.from({ length: 200 }, (_, i) => `Article number ${i} about rivers`)
const LINES = Array.from({ length: 200 }, (_, i) => `Segment line ${i} about tides`)

let articleFetches = 0
let lineFetches = 0

// Module scope, so the server and client roots share one registration.
// `staleTime: Infinity` makes "the client fetched nothing" a claim about
// hydration, not about timing.
const articlesQuery = defineQuery({
  id: 'streaming-hydration/articles',
  key: () => [],
  staleTime: Number.POSITIVE_INFINITY,
  fetcher: async () => {
    articleFetches += 1
    return ARTICLES
  },
})

const linesQuery = defineQuery({
  id: 'streaming-hydration/lines',
  key: () => [],
  staleTime: Number.POSITIVE_INFINITY,
  fetcher: async () => {
    lineFetches += 1
    // Settles after the shell is written, so it streams as its own segment.
    await new Promise((resolve) => setTimeout(resolve, 5))
    return LINES
  },
})

const shellFactory = (ctx: Ctx) => ({ articles: createQuery(ctx, articlesQuery) })
const shellDef = defineController(shellFactory)

const segmentFactory = (ctx: Ctx) => ({ lines: createQuery(ctx, linesQuery) })
const segmentDef = defineController(segmentFactory)

function Articles(): ReactElement {
  const api = useRoot<ReturnType<typeof shellFactory>>()
  const data = useValue(api.articles.data)
  const isLoading = useValue(api.articles.isLoading)
  return (
    <ul>
      {isLoading && <li>loading…</li>}
      {(data ?? []).map((title) => (
        <li key={title}>{title}</li>
      ))}
    </ul>
  )
}

function Lines(): ReactElement {
  const api = useRoot<ReturnType<typeof segmentFactory>>()
  const { data } = useSuspenseQuery(api.lines)
  return (
    <ol>
      {data.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ol>
  )
}

function SegmentPage(): ReactElement {
  return (
    <main>
      <h1>Tides</h1>
      <Suspense fallback={<p>loading…</p>}>
        <Lines />
      </Suspense>
    </main>
  )
}

/** React's two stream writers: the browser and edge builds' 2,048-byte views, and Node's 4,096. */
const BUILDS = [
  { build: 'the browser build', render: renderInBrowserBuild },
  { build: 'the Node build', render: renderInNodeBuild },
] as const

let renderToReadableStream: typeof renderInBrowserBuild = renderInBrowserBuild

/** Server: render `element` with the Olas bootstrap, through the transform. */
async function streamHtml(element: ReactElement, flush: () => string): Promise<string> {
  const stream = await renderToReadableStream(element, {
    bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT,
  })
  const reader = stream.pipeThrough(createStreamingTransform(flush)).getReader()
  const decoder = new TextDecoder()
  let html = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return html + decoder.decode()
    html += decoder.decode(value, { stream: true })
  }
}

const containers: HTMLElement[] = []

/**
 * Client: parse `html` into a container and run its inline scripts in
 * document order, as the browser's parser would. React 19.2+ reveals a
 * completed boundary on the next frame, so wait for the segments to move in.
 */
async function load(html: string): Promise<HTMLElement> {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  containers.push(container)
  for (const script of container.querySelectorAll('script')) {
    new Function(script.textContent ?? '')()
  }
  await vi.waitFor(() => expect(container.querySelector('[id^="S:"]')).toBeNull())
  return container
}

/** The batches `flush()` wrote, found by their payload. */
const batches = (container: HTMLElement): HTMLScriptElement[] =>
  [...container.querySelectorAll('script')].filter((s) =>
    (s.textContent ?? '').includes('JSON.parse('),
  )

async function hydrate(
  container: HTMLElement,
  element: ReactElement,
): Promise<{ recoverable: unknown[]; unmount: () => Promise<void> }> {
  const recoverable: unknown[] = []
  let reactRoot: ReturnType<typeof hydrateRoot> | undefined
  await act(async () => {
    reactRoot = hydrateRoot(container, element, {
      onRecoverableError: (err) => recoverable.push(err),
    })
  })
  return {
    recoverable,
    unmount: async () => {
      await act(async () => reactRoot?.unmount())
    },
  }
}

const roots: Array<Root<unknown>> = []
const keep = <R extends Root<unknown>>(root: R): R => {
  roots.push(root)
  return root
}

beforeEach(() => {
  articleFetches = 0
  lineFetches = 0
})

afterEach(() => {
  for (const root of roots.splice(0)) root.dispose()
  for (const container of containers.splice(0)) container.remove()
  const g = globalThis as Record<string, unknown>
  for (const name of [STREAMING_GLOBAL, '$RB', '$RC', '$RV', '$RT']) delete g[name]
})

describe.each(BUILDS)('createStreamingTransform against $build', ({ render }) => {
  beforeEach(() => {
    renderToReadableStream = render
  })

  test('a shell larger than a chunk, with data prefetched before render, hydrates cleanly', async () => {
    // The router README's pattern: the data is loaded before render, so a
    // batch is waiting when React's first chunk ends inside a list item.
    const { plugin, flush, dispose } = createStreamingHydrator()
    const server = keep(
      createRoot(shellDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }),
    )
    await server.waitForIdle()
    const html = await streamHtml(
      <OlasProvider root={server}>
        <Articles />
      </OlasProvider>,
      flush,
    )
    dispose()
    expect(html.length).toBeGreaterThan(4096)

    const container = await load(html)
    // Every batch sits at the container's top level, where React skips an
    // element it did not render.
    expect(batches(container)).not.toHaveLength(0)
    for (const script of batches(container)) expect(script.parentElement).toBe(container)

    articleFetches = 0
    const client = keep(
      createRoot(shellDef, { queries: queryEngine(), deps: {}, hydrate: server.dehydrate() }),
    )
    const { recoverable, unmount } = await hydrate(
      container,
      <OlasProvider root={client}>
        <Articles />
      </OlasProvider>,
    )
    expect(recoverable).toEqual([])
    expect(container.querySelectorAll('li')).toHaveLength(ARTICLES.length)
    expect(articleFetches).toBe(0)
    await unmount()
  })

  test('a Suspense segment larger than a chunk never carries a batch into its boundary', async () => {
    const { plugin, flush, dispose } = createStreamingHydrator()
    const server = keep(
      createRoot(segmentDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }),
    )
    const html = await streamHtml(
      <OlasProvider root={server}>
        <SegmentPage />
      </OlasProvider>,
      flush,
    )
    dispose()
    expect(html).toContain('<div hidden id="S:0">')

    // A batch inside `<div hidden id="S:0">` would be moved into the boundary
    // by React's reveal and hydrated against the client's tree.
    const container = await load(html)
    expect(batches(container)).not.toHaveLength(0)
    for (const script of batches(container)) expect(script.parentElement).toBe(container)

    const client = keep(
      createRoot(segmentDef, { queries: queryEngine(), deps: {}, hydrate: server.dehydrate() }),
    )
    const { recoverable, unmount } = await hydrate(
      container,
      <OlasProvider root={client}>
        <SegmentPage />
      </OlasProvider>,
    )
    expect(recoverable).toEqual([])
    expect(container.querySelectorAll('ol li')).toHaveLength(LINES.length)
    await unmount()
  })

  test('a whole document: every batch goes into <body>, the first one before the app', async () => {
    const { plugin, flush, dispose } = createStreamingHydrator()
    const server = keep(
      createRoot(shellDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }),
    )
    await server.waitForIdle()
    const html = await streamHtml(
      <html lang="en">
        <head>
          <title>Rivers</title>
        </head>
        <body>
          <div id="app">
            <OlasProvider root={server}>
              <Articles />
            </OlasProvider>
          </div>
        </body>
      </html>,
      flush,
    )
    dispose()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const shipped = [...doc.querySelectorAll('script')].filter((s) =>
      (s.textContent ?? '').includes('JSON.parse('),
    )
    expect(shipped).not.toHaveLength(0)
    for (const script of shipped) expect(script.parentElement).toBe(doc.body)
    // The prefetched batch precedes the markup that reads it.
    expect(html.indexOf('JSON.parse(')).toBeLessThan(html.indexOf('<div id="app">'))
    // Nothing moved into <head>, where a large script could push the charset
    // declaration past the first 1,024 bytes.
    expect(doc.head.querySelectorAll('script')).toHaveLength(0)
  })
})

describe.each(BUILDS)('HydrationBoundary over a page streamed by $build', ({ render }) => {
  beforeEach(() => {
    renderToReadableStream = render
  })

  test('batches that arrived before hydrateRoot are in the cache for the first render', async () => {
    // The client snippet from the SSR guide: no `hydrate`, only the stream.
    const { plugin, flush, dispose } = createStreamingHydrator()
    const server = keep(
      createRoot(shellDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }),
    )
    await server.waitForIdle()
    const html = await streamHtml(
      <OlasProvider root={server}>
        <Articles />
      </OlasProvider>,
      flush,
    )
    dispose()

    const container = await load(html)
    articleFetches = 0
    const { recoverable, unmount } = await hydrate(
      container,
      <HydrationBoundary def={shellDef} options={{ deps: {}, queries: queryEngine() }}>
        <Articles />
      </HydrationBoundary>,
    )
    expect(recoverable).toEqual([])
    expect(container.textContent).not.toContain('loading…')
    expect(container.querySelectorAll('li')).toHaveLength(ARTICLES.length)
    // The rows were buffered before the controllers bound their keys, so the
    // root never started a fetch of its own.
    expect(articleFetches).toBe(0)
    await unmount()
  })

  test('a streamed Suspense segment hydrates from its batch, with no client fetch', async () => {
    const { plugin, flush, dispose } = createStreamingHydrator()
    const server = keep(
      createRoot(segmentDef, { queries: queryEngine(), deps: {}, plugins: [plugin] }),
    )
    const html = await streamHtml(
      <OlasProvider root={server}>
        <SegmentPage />
      </OlasProvider>,
      flush,
    )
    dispose()

    const container = await load(html)
    lineFetches = 0
    const { recoverable, unmount } = await hydrate(
      container,
      <HydrationBoundary def={segmentDef} options={{ deps: {}, queries: queryEngine() }}>
        <SegmentPage />
      </HydrationBoundary>,
    )
    expect(recoverable).toEqual([])
    expect(container.querySelectorAll('ol li')).toHaveLength(LINES.length)
    expect(lineFetches).toBe(0)
    await unmount()
  })
})
