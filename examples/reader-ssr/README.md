# Example — reader-ssr (React + SSR)

An infinite-scroll article reader, server-rendered on first paint. Demonstrates
Olas's lean SSR story: `waitForIdle → dehydrate` on the server, `createRoot(...,
{ hydrate })` on the client. No framework-specific data layer; no `getServerSideProps`.

## What it shows

- **`defineQuery` keyed by cursor + reactive `key` thunk** — every loaded page is its own cache entry, individually dehydratable. Pagination is modeled as a `currentCursor` signal driving the subscription's key thunk; the controller accumulates pages into a single signal. (See the in-code note about `defineInfiniteQuery` — its entries aren't yet covered by `root.dehydrate()`, so regular queries are the SSR-friendly shape today.)
- **SSR round-trip** — server `await root.waitForIdle(); root.dehydrate()` produces a `DehydratedState`; client `createRoot(..., { hydrate })` populates the cache before subscribe. The headline test in `tests/ssr.test.ts` asserts the client api is **never called** for what the server already fetched. Spec §15.
- **`useSuspendOnHidden`** — suspends the root when the tab is hidden (effects torn down, cache preserved); resumes on visible. See `tests/useSuspendOnHidden.test.tsx`. Spec §20.10.
- **`usePersisted`** — reading progress (`lastArticleId`) saved to localStorage; SSR runs with `storage: undefined` and the persist adapter gracefully no-ops. Spec §13.
- **`ctx.emitter` + `ctx.on`** — analytics events flow through a controller-owned emitter to a `ctx.deps.analytics` adapter.
- **`onError` root option + `ErrorContext`** — errors from any effect / cache / mutation route through a single, typed handler.

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
pnpm --filter @olas/example-reader-ssr dev          # http://localhost:5182

# Production build + SSR server:
pnpm --filter @olas/example-reader-ssr preview      # builds, then http://localhost:5183
# or step-by-step:
pnpm --filter @olas/example-reader-ssr build
pnpm --filter @olas/example-reader-ssr serve

pnpm --filter @olas/example-reader-ssr typecheck
pnpm --filter @olas/example-reader-ssr test
```

## How to confirm SSR is actually working

1. `pnpm --filter @olas/example-reader-ssr preview`.
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
