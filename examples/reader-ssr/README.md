# Example — reader-ssr (React + SSR)

An infinite-scroll article reader, server-rendered on first paint. Demonstrates
Olas's lean SSR story: `waitForIdle → dehydrate` on the server, `createRoot(...,
{ hydrate })` on the client. No framework-specific data layer; no `getServerSideProps`.

## What it shows

- **`defineQuery` keyed by cursor + reactive `key` thunk** — every loaded page is its own cache entry, individually dehydratable. Pagination is modeled as a `currentCursor` signal driving the subscription's key thunk; the controller accumulates pages into a single signal. (See the in-code note about `defineInfiniteQuery` — its entries aren't yet covered by `root.dehydrate()`, so regular queries are the SSR-friendly shape today.)
- **SSR round-trip** — server `await root.waitForIdle(); root.dehydrate()` produces a `DehydratedState`; client `createRoot(..., { hydrate })` populates the cache before subscribe. The headline test in `tests/ssr.test.ts` asserts the client api is **never called** for what the server already fetched. Spec §15.
- **`useSuspendOnHidden`** — suspends the root when the tab is hidden (effects torn down, cache preserved); resumes on visible. See `tests/useSuspendOnHidden.test.tsx`. Spec §20.10.
- **`usePersisted` behind a hydration gate** — theme, bookmarks and reading progress are saved to localStorage; SSR runs with `storage: undefined` and the persist adapter no-ops. The client then has to hold those values back for one render, which `src/App.tsx` does with `useHydrated`. See [Persisted state and the first render](#persisted-state-and-the-first-render). Spec §13.
- **`ctx.emitter` + `ctx.on`** — analytics events flow through a controller-owned emitter to a `ctx.deps.analytics` adapter.
- **`onError` root option + `ErrorContext`** — errors from any effect, cache and mutation route through a single, typed handler.

## Files

- `src/api.ts` — deterministic, cursor-paginated fake feed (so SSR/CSR HTML matches).
- `src/controller.ts` — `articleFeedQuery`, `readerController`, root composition with `onError`.
- `src/App.tsx` — React component (`useQuery`, `use`, `useSuspendOnHidden`).
- `src/entry-server.tsx` — exports `render(url)` → `{ html, state }`.
- `src/entry-client.tsx` — picks state from `window.__OLAS_STATE__`, calls `hydrateRoot`.
- `server.mjs` — tiny Express prod server: read template, call `render`, splice html + state, send.
- `tests/ssr.test.ts` — SSR cache-hit assertion + `fetchNextPage` after hydrate.
- `tests/controller.test.ts` — infinite progression + analytics emitter.
- `tests/useSuspendOnHidden.test.tsx` — visibilitychange behavior.

## Run it

```bash
pnpm install

# Plain SPA dev mode (no SSR — fast iteration):
pnpm --filter @kontsedal/olas-example-reader-ssr dev          # http://localhost:5182

# Production build + SSR server:
pnpm --filter @kontsedal/olas-example-reader-ssr preview      # builds, then http://localhost:5183
# or step-by-step:
pnpm --filter @kontsedal/olas-example-reader-ssr build
pnpm --filter @kontsedal/olas-example-reader-ssr serve

pnpm --filter @kontsedal/olas-example-reader-ssr typecheck
pnpm --filter @kontsedal/olas-example-reader-ssr test
```

## Persisted state and the first render

`usePersisted` reads its adapter while the controller is constructed, and `localStorageAdapter` reads synchronously. A returning visitor therefore has their stored theme, bookmarks and reading progress in the signals before `hydrateRoot` runs — while the server, which has no localStorage, built its HTML from the defaults. Rendering the stored values on the hydrating pass is a hydration mismatch, and React resolves those by throwing the server's markup away.

`src/App.tsx` holds the three values back for exactly one render:

```tsx
const hydrated = useHydrated()
const theme = hydrated ? use(api.reader.theme) : 'auto'

function useHydrated(): boolean {
  // React uses the third argument for the server render AND for the
  // client's hydrating render, so both sides agree on `false`.
  return useSyncExternalStore(subscribeToNothing, alwaysTrue, alwaysFalse)
}
```

This is the general shape for anything the server cannot see: localStorage, `window.matchMedia`, the current time. It costs one extra client render, and the first paint shows the default theme before the stored one. An app that cannot accept the theme flash writes `data-theme` from a blocking inline script in the document head, before React runs.

The controller stays untouched: it is the renderer, not the store, that owes the server an identical first pass.

## How to confirm SSR is actually working

1. `pnpm --filter @kontsedal/olas-example-reader-ssr preview`.
2. Open `http://localhost:5183` in a browser with DevTools open.
3. Disable JavaScript and reload — the article list still renders (server-rendered HTML).
4. Re-enable JS, open the Network tab, hard-refresh — the page's HTML carries the data; **no `getPage` request fires on first paint**. Only when you click "Load more" does the client hit the api.
5. View source — you'll see a `window.__OLAS_STATE__ = { ... }` script tag with the dehydrated cache entries.

## Read order

1. `src/api.ts` — types and the deterministic data set.
2. `src/controller.ts` — the infinite query + the reader controller.
3. `src/entry-server.tsx` and `src/entry-client.tsx` — the seam between server and client.
4. `tests/ssr.test.ts` — the SSR contract, expressed as a Node test.
5. `server.mjs` — the (very small) production wrapper.
