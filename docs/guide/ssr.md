# Server rendering

Olas renders on the server with the same controllers the client runs. The server fetches, renders and serializes the query cache. The client builds its root from that payload, so its subscriptions start with the server's data instead of a loading state, and the hydrating render matches the server's HTML.

Core ships the serialization primitives: `waitForIdle`, `dehydrate`, `hydrate` and `serializeForScript` (§15). The React adapter builds `HydrationBoundary` and streaming SSR on top of them (§16.1). This page covers the one-shot render first, then streaming, then the sharp edges.

## The model

Only the query cache crosses the wire. Controller state does not: the client runs every controller factory again from its props, and each subscription re-binds to a cache that already holds the server's data.

```text
server, one root per request                    client
createRoot(def, { queries, deps })              createRoot(def, { queries, deps, hydrate })
  controllers construct, queries fetch            controllers construct again
await root.waitForIdle()                          each subscription finds its data
render the app with <OlasProvider root>         hydrateRoot(... <OlasProvider root> ...)
serializeForScript(root.dehydrate())  ───────▶  window.__OLAS_STATE__
root.dispose()
```

## One root per request

A root owns its query client (see [why each root has its own client](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/per-root-query-client.md)). A server that kept one root at module scope would serve one visitor's cached data in another visitor's HTML. So the server builds a root for each request, with that request's `deps`, and disposes it when the response is done.

The query definitions stay at module scope. A definition holds no data; each root that binds it builds its own entries.

## Query ids must match

Every shared query has a hand-written `id`, and `defineQuery` and `defineInfiniteQuery` throw on a missing or empty one. Each dehydrated entry carries its query's `id` beside its key, and the client finds the entry's query by that `id`. Registration order plays no part.

So the server bundle and the client bundle must define each query with the same `id`. Import one definitions module from both entries, and write the `id` as a literal. A derived name such as `fetcher.name` changes under minification, and the two bundles are minified separately.

Hydration is keyed by `id` and key hash together. Two queries whose keys hash the same cannot adopt each other's data. A payload you write by hand must set each entry's `id` to its target query's `id`.

The rest of this page uses one small app. Both bundles import it:

```ts file=app-controller.ts
import { createQuery, defineController, defineQuery } from '@kontsedal/olas-core'

export type Article = { id: string; title: string }
export type FeedPage = { items: Article[]; nextCursor: string | null }

export type Api = {
  listArticles(signal: AbortSignal): Promise<Article[]>
  feedPage(cursor: string, signal: AbortSignal): Promise<FeedPage>
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: Api
  }
}

// The id names this data in the payload, so both bundles must agree on it.
export const articlesQuery = defineQuery({
  id: 'articles/list',
  key: () => [],
  fetcher: ({ signal, deps }) => deps.api.listArticles(signal),
  staleTime: 60_000,
})

export const appController = defineController((ctx) => ({
  articles: createQuery(ctx, articlesQuery),
}))
```

## Render on the server

The server builds the root, waits for the cache, renders, and serializes:

```tsx file=server.tsx
import { createRoot, queryEngine, serializeForScript } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { renderToString } from 'react-dom/server'
import { createApi } from './api'
import { App } from './App'
import { appController } from './app-controller'

export async function render(request: Request): Promise<string> {
  const root = createRoot(appController, {
    queries: queryEngine(),
    deps: { api: createApi(request.headers.get('cookie')) },
  })
  try {
    await root.waitForIdle()
    const html = renderToString(
      <OlasProvider root={root}>
        <App />
      </OlasProvider>,
    )
    const state = serializeForScript(root.dehydrate())
    return `<div id="app">${html}</div><script>window.__OLAS_STATE__ = ${state}</script>`
  } finally {
    root.dispose()
  }
}
```

The controllers subscribe while the root constructs, so `waitForIdle` sees their fetches. `root.waitForIdle()` resolves when three things hold at once (§15):

- no cache entry has a fetch in flight;
- no mutation is in flight, and a queued `serial` run counts;
- no work a plugin passed to `host.track` is pending.

It loops until nothing moves, because a settling fetch can start another fetch, and plugin work can start fetches too. After 100 rounds it throws, so a runaway setup fails the render instead of shipping a payload that looks complete and is not. A fetch that starts after `waitForIdle` resolves does not block it.

`root.dehydrate()` returns a JSON-serializable `DehydratedState`. It holds each entry with `status: 'success'`: its `id`, `key`, `data` and `lastUpdatedAt`. Errors and pending fetches are left out, so a query that failed on the server fetches again on the client. A root without a query engine returns an empty state.

## Inline the state safely

Query data is untrusted text. An article title can contain `</script>`, and a bare `JSON.stringify` inside a `<script>` would let it end the tag. `serializeForScript(value)` returns `JSON.parse("…")` over the JSON, with every character that could end the string, the script or an attribute written as a `\uXXXX` escape. A key named `__proto__` stays an own property, where an object literal would make it the prototype. It throws what `JSON.stringify` throws, for a `BigInt` or a cycle.

Two more rules for the page template:

- **Splice with a function replacement.** `template.replace(slot, html)` expands `$'`, `$&` and `$1` in `html`, so text in the page could paste parts of the template back in. `template.replace(slot, () => html)` does not. The [reader-ssr example](https://github.com/Kontsedal/olas/blob/main/examples/reader-ssr/src/page.ts) does both splices this way, and `tests/page.test.ts` covers both cases.
- **Give the script a nonce under a nonce-based CSP.** A `script-src 'nonce-…'` policy blocks an inline `<script>` without the matching `nonce` attribute. The state script is yours to write, so the nonce is yours to add. The streaming hydrator adds it for you (below).

## Hydrate on the client

The client builds its own root, with a query engine and the payload:

```tsx file=client.tsx
import { createRoot, type DehydratedState, queryEngine } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { hydrateRoot } from 'react-dom/client'
import { createApi } from './api'
import { App } from './App'
import { appController } from './app-controller'

declare global {
  interface Window {
    __OLAS_STATE__?: DehydratedState
  }
}

const root = createRoot(appController, {
  queries: queryEngine(),
  deps: { api: createApi() },
  hydrate: window.__OLAS_STATE__,
})

hydrateRoot(
  document.getElementById('app') as HTMLElement,
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)
```

`hydrate` needs `queries`. A root without an engine has no cache to seed, so it discards the payload, and development builds warn.

The client buffers each entry by `id` and key hash, and the first subscription that binds the key adopts it with `status: 'success'`. A buffered entry is consumed once. If its controller disposes and the key binds again later, that bind fetches as usual, because hydration is a warm start, not a second cache.

The payload's `lastUpdatedAt` still counts against `staleTime`. With the default `staleTime: 0`, hydrated data is stale at once, so the client refetches it in the background on subscribe: `status` stays `'success'` while `isFetching` turns true. A `staleTime` such as the `60_000` above skips that refetch.

### Or let `HydrationBoundary` own the client root

`HydrationBoundary` builds the client root from a controller def and root options, provides it, and disposes it on unmount:

```tsx
import { queryEngine } from '@kontsedal/olas-core'
import { HydrationBoundary } from '@kontsedal/olas-react'
import { hydrateRoot } from 'react-dom/client'
import { createApi } from './api'
import { App } from './App'
import { appController } from './app-controller'

hydrateRoot(
  document.getElementById('app') as HTMLElement,
  <HydrationBoundary
    def={appController}
    options={{ queries: queryEngine(), deps: { api: createApi() }, hydrate: window.__OLAS_STATE__ }}
  >
    <App />
  </HydrationBoundary>,
)
```

It reads `options` once, on mount, and it survives a StrictMode remount. By default it also installs the streaming intake; pass `streaming={false}` for a one-shot payload. Full props: [`HydrationBoundary`](/reference/olas-react.hydrationboundary).

## Infinite queries

An infinite query dehydrates too. Its entry carries the loaded pages as `data` and one param per page as `pageParams`. The client seeds the pages without refetching them, and `fetchNextPage` continues from the last param (§5.11).

```ts file=feed.ts
import { createQuery, defineController, defineInfiniteQuery } from '@kontsedal/olas-core'
import type { FeedPage } from './app-controller'

export const feedQuery = defineInfiniteQuery({
  id: 'articles/feed',
  key: () => [],
  fetcher: ({ pageParam, signal, deps }) => deps.api.feedPage(pageParam, signal),
  initialPageParam: '',
  getNextPageParam: (last: FeedPage) => last.nextCursor,
  itemsOf: (page: FeedPage) => page.items,
  staleTime: 60_000,
})

export const feedController = defineController((ctx) => ({
  feed: createQuery(ctx, feedQuery),
}))
```

The server loads the first page on its own. To render more, fetch them before you dehydrate:

<!-- snippet-prelude
import type { Root } from '@kontsedal/olas-core'
import type { feedController } from './feed'
type FeedApi = typeof feedController extends import('@kontsedal/olas-core').ControllerDef<void, infer A> ? A : unknown
declare const root: Root<FeedApi>
-->
```ts
await root.waitForIdle()
await root.api.feed.fetchNextPage() // the payload now holds two pages and two params
const state = root.dehydrate()
```

The client adopts an infinite entry only when `pageParams` holds one param per page. A hand-written payload for an infinite query must carry them.

## Streaming SSR

The one-shot path serializes the cache once, after the slowest query resolves, so the whole response waits on the slowest fetcher. Streaming sends each entry into the HTML stream as it resolves. It pairs with `<Suspense>`. A component that suspends on its query with `useSuspenseQuery` lets React stream its boundary once the data lands, and the hydrator streams that data to the client (§15).

Four pieces, all in `@kontsedal/olas-react`:

| Piece | Side | What it does |
|---|---|---|
| `createStreamingHydrator({ nonce })` | server | Returns `{ plugin, flush, dispose }`. The plugin records the root's committed writes, and `flush()` drains them as one `<script>` tag. |
| `createStreamingTransform(flush)` | server | A `TransformStream` over React's HTML stream that writes each batch only between elements. |
| `OLAS_BOOTSTRAP_SCRIPT` | client, sent by the server | Primes a push-only queue before React hydrates. |
| `HydrationBoundary` | client | On mount, applies the queued batches to its root, then each later batch as it arrives. |

### The server

The hydrator's plugin goes on the per-request root, and that same root renders:

```tsx file=stream-server.tsx
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import {
  createStreamingHydrator,
  createStreamingTransform,
  OLAS_BOOTSTRAP_SCRIPT,
  OlasProvider,
} from '@kontsedal/olas-react'
import { renderToReadableStream } from 'react-dom/server'
import { createApi } from './api'
import { appController } from './app-controller'
import { Document } from './Document'

export async function handle(request: Request): Promise<Response> {
  const nonce = crypto.randomUUID()
  const hydrator = createStreamingHydrator({ nonce })
  const root = createRoot(appController, {
    queries: queryEngine(),
    deps: { api: createApi(request.headers.get('cookie')) },
    plugins: [hydrator.plugin],
  })
  const cleanup = () => {
    root.dispose()
    hydrator.dispose()
  }

  let stream: ReadableStream<Uint8Array>
  try {
    stream = await renderToReadableStream(
      <OlasProvider root={root}>
        <Document />
      </OlasProvider>,
      { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT, nonce },
    )
  } catch (error) {
    cleanup()
    throw error
  }

  const body = stream
    .pipeThrough(createStreamingTransform(hydrator.flush))
    // Runs after the transform's final drain, when the response is complete.
    .pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: cleanup }))

  return new Response(body, {
    headers: {
      'content-type': 'text/html',
      'content-security-policy': `script-src 'nonce-${nonce}'`,
    },
  })
}
```

The plugin records the writes that the server confirmed: a fetch resolving, a canonical `write` or a `replace`. It keeps the latest value per query `id` and key. It skips `'hydrate'` writes, which are data the client already has, and optimistic writes and rollbacks, which are guesses the server has not confirmed. An infinite entry carries its `pageParams`.

`nonce` goes on every tag the hydrator emits, and the same value passed to `renderToReadableStream` goes on React's own scripts, so one `script-src 'nonce-…'` policy admits both.

The transform drains once more when the stream closes, so entries that settle after the last chunk still reach the client. `Document` in this example renders the whole page, `<html>` included.

### Dispose after the response

The server root and the hydrator both hold state for this one request. Dispose them once the response has finished: the root first, then `hydrator.dispose()`. The example does it in a last `TransformStream`, whose `flush` runs after the streaming transform's final drain. A client that disconnects cancels the stream instead of closing it, and `flush` does not run on cancel, so also run the same cleanup from your server's connection-close hook. `root.dispose()` is idempotent, and so is `hydrator.dispose()`.

### The client

The client renders the same tree under a `HydrationBoundary`:

```tsx
import { queryEngine } from '@kontsedal/olas-core'
import { HydrationBoundary } from '@kontsedal/olas-react'
import { hydrateRoot } from 'react-dom/client'
import { createApi } from './api'
import { appController } from './app-controller'
import { Document } from './Document'

hydrateRoot(
  document,
  <HydrationBoundary def={appController} options={{ queries: queryEngine(), deps: { api: createApi() } }}>
    <Document />
  </HydrationBoundary>,
)
```

Batches can arrive before React hydrates. `OLAS_BOOTSTRAP_SCRIPT` queues them, and each flushed tag checks that the global is a real intake before it pushes, so a page element with the id `__OLAS_HYDRATION__` cannot clobber it. When the boundary mounts, it calls `installStreamingIntake(root)`:

1. It upgrades the queue into an intake that keeps every batch it has seen.
2. It applies the batches that arrived before mount to this root.
3. It applies each later batch to every installed root.

A second boundary, or the fresh root of a StrictMode remount, therefore catches up on the stream instead of taking it from the first root. Each batch goes through `root.hydrate` inside one signal `batch`, so subscribers see one notification per batch. A bound entry takes its row at once, and the row supersedes any fetch in flight for it. An unbound key waits in the buffer until its first bind. A client root that no `HydrationBoundary` builds connects with [`installStreamingIntake(root)`](/reference/olas-react.installstreamingintake), which returns the uninstall.

### Why the transform places the tags

React writes its stream in fixed-size chunks. React 19 uses 2,048-byte views, so a chunk boundary falls wherever the byte count lands: inside a tag, an attribute name or an attribute value. A `<script>` written at a boundary inside an attribute value becomes part of that value, and the first `"` in the script closes it.

`createStreamingTransform` did that before 1.0, and the security review reproduced an XSS with it. Query data `{ bio: ' onfocus=alert(1) autofocus x=' }` became real attributes on an `<a>`, with no `<` in the payload at all. The transform now runs a small HTML tokenizer over the bytes it passes through. It writes a batch only when a chunk ends in text, between elements. Otherwise it holds the batch, and the entries keep collecting in the hydrator until a chunk ends at a boundary. Behind that, `serializeForScript` escapes every quote, angle bracket and `=` in the payload, so data that did land in the wrong place still could not form attributes. [The stream-chunks pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/stream-chunks-split-tags.md) has the detail.

### Why not flush from a Node `Transform`

A hand-written Node `Transform` that calls `flush()` after each chunk writes wherever the chunk boundary lands, which is the unsafe case above. Deferring the write by a macrotask does not fix it. Under backpressure a pipe reads one React flush across several tasks, and `renderToPipeableStream` stops mid-flush when `write` returns `false`.

On Node, render with `renderToReadableStream`, since Node has Web Streams, and pipe through `createStreamingTransform`. Otherwise, write `flush()` output only after the stream has ended, where it is known to sit between elements.

## Render with `OlasProvider` on the server

`HydrationBoundary` is the client half. It builds its root during render and disposes it in an effect, and React runs no effects on the server. A `HydrationBoundary` rendered on the server therefore builds a root that nothing disposes, and the handler holds no reference to it. That root's subscriptions, timers and cache outlive the response.

On the server, build the per-request root yourself, render it through `OlasProvider`, and dispose it when the response is done, as both server examples above do. A development build warns once when a `HydrationBoundary` renders on the server, so the mistake shows up in the server log.

## Persisted state and the first render

`createPersisted` from `@kontsedal/olas-persist` reads its storage while the controller constructs, and `localStorageAdapter()` reads synchronously. A returning visitor's client root therefore holds their stored theme before `hydrateRoot` runs. The server had no localStorage and rendered the default. React treats that as a hydration mismatch, discards the server's DOM for the subtree, and renders it again on the client. Only returning visitors hit it, so it survives first-visit tests.

The fix belongs in the renderer, not the controller. Hold the stored value back for one render:

```tsx
import type { ReadSignal } from '@kontsedal/olas-core'
import { useValue } from '@kontsedal/olas-react'
import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark' | 'auto'

export function ThemeLabel(props: { theme: ReadSignal<Theme> }) {
  const hydrated = useHydrated()
  // Read the signal on every render, so the hook order never changes.
  const stored = useValue(props.theme)
  return <span>{hydrated ? stored : 'auto'}</span>
}

function useHydrated(): boolean {
  // React uses the third argument for the server render and for the client's
  // hydrating render, so both sides agree on `false`.
  return useSyncExternalStore(subscribeToNothing, () => true, () => false)
}

const subscribeToNothing = () => () => {}
```

It costs one extra client render, and the first paint shows the default. The same shape fits anything the server cannot see, such as `window.matchMedia` or the current time. [The persisted-state pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/persisted-state-breaks-hydration.md) explains why the persist read stays synchronous.

## The trust model

SPEC [§22](https://github.com/Kontsedal/olas/blob/main/SPEC.md#22-trust-model) sets what Olas trusts. For SSR:

- **A `DehydratedState` is trusted as authored.** It comes from your own server. Core checks its `version` and each entry's shape, and skips an entry it cannot read, but it does not treat the payload as hostile. Pass `hydrate` only a payload your server wrote, not one read from a URL, a cookie or user input.
- **Query data is untrusted.** Olas never evaluates it and never lets its keys change a prototype. `serializeForScript` and the streaming transform escape it for every HTML context they write it into.
- **Every script in the page is trusted.** Same-origin code can already push to the streaming intake, so Olas does not defend the intake against it.

Olas does not check that hydrated data matches a query's type.

## Where next

- [Recipes: server rendering, one root per request](/guide/recipes#server-rendering-—-one-root-per-request) has the one-shot path as copyable server and client files.
- [The React adapter](/adapters/react#ssr-hydration) lists the streaming exports.
- [`examples/reader-ssr`](https://github.com/Kontsedal/olas/tree/main/examples/reader-ssr) runs the one-shot path end to end, with a hydration gate for persisted state.
- Reference: [`createRoot`](/reference/olas-core.createroot), [`Root`](/reference/olas-core.root), [`serializeForScript`](/reference/olas-core.serializeforscript), [`DehydratedState`](/reference/olas-core.dehydratedstate), [`createStreamingHydrator`](/reference/olas-react.createstreaminghydrator), [`createStreamingTransform`](/reference/olas-react.createstreamingtransform).
