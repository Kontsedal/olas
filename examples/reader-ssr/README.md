# Example — reader-ssr (React + SSR)

An infinite-scroll article reader, server-rendered on first paint. Demonstrates
Olas's lean SSR story: `waitForIdle → dehydrate` on the server, `createRoot(...,
{ hydrate })` on the client. No framework-specific data layer; no `getServerSideProps`.

## What it shows

- **`defineQuery` keyed by cursor + reactive `key` thunk** — every loaded page is its own cache entry, individually dehydratable. Pagination is modeled as a `currentCursor` signal driving the subscription's key thunk; the controller accumulates pages into a single signal. `defineInfiniteQuery` dehydrates as well, with its page params (spec §15). This example keeps regular entries to show accumulation through a reactive key.
- **SSR round-trip** — server `await root.waitForIdle(); root.dehydrate()` produces a `DehydratedState`; client `createRoot(..., { hydrate })` populates the cache before subscribe. The headline test in `tests/ssr.test.ts` asserts the client api is **never called** for what the server already fetched. Spec §15.
- **A safe page** — `renderPage` in `src/page.ts` splices the HTML and the state into the template. The state goes in through core's `serializeForScript`, so data containing `</script>` cannot end the tag. See [What the server writes](#what-the-server-writes).
- **`useSuspendOnHidden`** — suspends the root when the tab is hidden (effects torn down, cache preserved); resumes on visible. See `tests/useSuspendOnHidden.test.tsx`. Spec §20.10.
- **`createPersisted` behind a hydration gate** — theme, bookmarks and reading progress are saved to localStorage; SSR runs with `storage: undefined` and the persist adapter no-ops. The client then has to hold those values back for one render, which `src/App.tsx` does with `useHydrated`. See [Persisted state and the first render](#persisted-state-and-the-first-render). Spec §13.4.
- **`ctx.attach` for the comment composer** — each article's composer is a controller with a form and a `debouncedValidator`, built on open and disposed on close.
- **`ctx.emitter` + `ctx.on`** — analytics events flow through a controller-owned emitter to a `ctx.deps.analytics` adapter.
- **`onError` root option + `ErrorContext`** — errors from any effect, cache and mutation route through a single, typed handler.

## Files

- `src/api.ts` — deterministic, cursor-paginated fake feed (so SSR/CSR HTML matches).
- `src/controller.ts` — `pageQuery`, `readerController`, root composition with `onError`.
- `src/composer-controller.ts` — the per-article comment composer: a form, a debounced server-side validator, a comments cache and the post mutation.
- `src/App.tsx` — React component (`useRoot`, `useValue`, `useSuspendOnHidden`).
- `src/Composer.tsx` — the composer's view (`useField`, `useFieldInput`).
- `src/page.ts` — `renderPage(template, html, state)`: the splice into the HTML template.
- `src/entry-server.tsx` — exports `render(url)` → `{ html, state }`, and re-exports `renderPage`.
- `src/entry-client.tsx` — picks state from `window.__OLAS_STATE__`, calls `hydrateRoot`.
- `server.mjs` — tiny Express prod server: read template, call `render`, pass the result through `renderPage`, send.
- `tests/ssr.test.ts` — SSR cache-hit assertion + `loadMore` after hydrate.
- `tests/controller.test.ts` — pagination, bookmarks, theme persistence, the analytics emitter, and a posted comment.
- `tests/page.test.ts` — hostile text in the state or the HTML stays inside the page.
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

## What the server writes

`index.html` holds two slots: `<!--app-html-->` inside `#app`, and a `window.__OLAS_STATE__ = /*--olas-state--*/null/*--olas-state--*/` script. `renderPage` fills both.

- **The state goes through `serializeForScript`.** It emits `JSON.parse("…")` with every character that could end the string, the script or an attribute written as a `\uXXXX` escape. So an article title containing `</script><img onerror=…>` stays a string. A key named `__proto__` stays an own property, where an object literal would make it the prototype.
- **Both replacements are functions.** A string replacement expands `$'`, `$&` and `$1`. With one, text in the rendered HTML or the state could paste parts of the template back into the page. `tests/page.test.ts` covers both cases.

This example renders to a string. A streaming server uses `createStreamingHydrator` and `createStreamingTransform` from `@kontsedal/olas-react` instead. That transform writes each state batch only between elements, and `createStreamingHydrator({ nonce })` puts a Content-Security-Policy nonce on every script it emits. Under a nonce-based CSP, the inline state script in `index.html` needs a nonce too.

## Persisted state and the first render

`createPersisted` reads its adapter while the controller is constructed, and `localStorageAdapter()` reads synchronously. A returning visitor therefore has their stored theme, bookmarks and reading progress in the signals before `hydrateRoot` runs — while the server, which has no localStorage, built its HTML from the defaults. Rendering the stored values on the hydrating pass is a hydration mismatch, and React resolves those by throwing the server's markup away.

`src/App.tsx` holds the three values back for exactly one render. Trimmed to the theme:

```tsx
import { useRoot, useValue } from '@kontsedal/olas-react'
import { useSyncExternalStore } from 'react'
import type { AppApi, Theme } from './controller'

/** What the server renders, because it has no localStorage to read. */
const NO_THEME: Theme = 'auto'

export function ThemeLabel() {
  const api = useRoot<AppApi>()
  const hydrated = useHydrated()
  // Read the signal on every render, so the hook order never changes.
  const storedTheme = useValue(api.reader.theme)
  const theme = hydrated ? storedTheme : NO_THEME
  return <span>{theme}</span>
}

function useHydrated(): boolean {
  // React uses the third argument for the server render AND for the
  // client's hydrating render, so both sides agree on `false`.
  return useSyncExternalStore(subscribeToNothing, alwaysTrue, alwaysFalse)
}

const subscribeToNothing = (): (() => void) => noop
const noop = (): void => {}
const alwaysTrue = (): boolean => true
const alwaysFalse = (): boolean => false
```

This is the general shape for anything the server cannot see: localStorage, `window.matchMedia`, the current time. It costs one extra client render, and the first paint shows the default theme before the stored one. An app that cannot accept the theme flash writes `data-theme` from a blocking inline script in the document head, before React runs.

The controller stays untouched: it is the renderer, not the store, that owes the server an identical first pass.

## How to confirm SSR is actually working

1. `pnpm --filter @kontsedal/olas-example-reader-ssr preview`.
2. Open `http://localhost:5183` in a browser with DevTools open.
3. Disable JavaScript and reload — the article list still renders (server-rendered HTML).
4. Re-enable JS, open the Network tab, hard-refresh — the page's HTML carries the data; **no `getPage` request fires on first paint**. Only when you click "Load more" does the client hit the api.
5. View source — you'll see a `window.__OLAS_STATE__ = JSON.parse("…")` script tag with the dehydrated cache entries, escaped by `serializeForScript`.

## Read order

1. `src/api.ts` — types and the deterministic data set.
2. `src/controller.ts` — the paged query + the reader controller.
3. `src/entry-server.tsx` and `src/entry-client.tsx` — the seam between server and client.
4. `src/page.ts` — how the state reaches the page.
5. `tests/ssr.test.ts` — the SSR contract, expressed as a Node test.
6. `server.mjs` — the (very small) production wrapper.
