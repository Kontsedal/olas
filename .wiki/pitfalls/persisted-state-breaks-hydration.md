---
name: persisted-state-breaks-hydration
description: usePersisted reads localStorage during controller construction, so a returning visitor's first client render disagrees with the server HTML. Gate the values, not the controller.
type: pitfall
covers:
  - packages/persist/src/index.ts:286-300
  - packages/persist/src/index.ts:436-450
  - examples/reader-ssr/src/App.tsx
  - examples/reader-ssr/src/controller.ts:110-130
edges:
  - { type: uses, target: ../modules/persist.md }
  - { type: uses, target: ../flows/ssr.md }
  - { type: tested-by, target: ../../packages/react/tests/ssr-hydration.test.tsx }
last_verified: 2026-09-21
confidence: medium
---

# Persisted state breaks hydration

## The trap

`usePersisted(ctx, key, source)` loads the stored value while the controller is being constructed (`persist/src/index.ts:436-437`, `const loaded = storage.get(key)`). For `localStorageAdapter` that read is synchronous (`index.ts:286-300`). The client builds its root before `hydrateRoot`, so by the time React hydrates, the signal already holds the visitor's stored value.

The server had no localStorage. It rendered the default.

```ts
// controller.ts — runs on both sides
const theme = signal<Theme>('auto')
usePersisted(ctx, 'app.theme', theme)   // server: stays 'auto'. client: 'dark', already
```

```tsx
// App.tsx — server emits "Auto", client's first pass renders "Dark"
<span>{useValue(api.theme)}</span>
```

That is a hydration mismatch. React does not patch it up. It discards the server's DOM for that subtree and re-renders on the client, which is the whole cost the server render was paying to avoid. It only happens for a **returning** visitor, so it survives every first-visit test and every fresh-profile manual check.

## What it affects

Anything the server cannot see, and not only persisted state. `window.matchMedia`, `Date.now()` rendered as a relative time, a random id, a feature flag read from a cookie the server did not parse.

## The fix belongs in the renderer

Do not change what the controller does. The controller is right — the stored value IS the state. What is wrong is rendering it on the pass whose job is to match markup the server already sent. Hold it back for one render:

```tsx
const hydrated = useHydrated()
const theme = hydrated ? useValue(api.theme) : 'auto'

function useHydrated(): boolean {
  // React uses the third argument for the server render AND for the
  // client's hydrating render, so the two sides agree on `false`.
  return useSyncExternalStore(subscribeToNothing, alwaysTrue, alwaysFalse)
}
```

`examples/reader-ssr/src/App.tsx` does exactly this for theme, bookmarks and reading progress, and its README explains the trade under "Persisted state and the first render".

## What it costs

One extra client render, and a first paint showing the default before the stored value. For a theme that flash is visible. An app that cannot accept it writes `data-theme` from a blocking inline script in the document head, before React runs at all. That is a different mechanism, outside React's render, and it does not interact with hydration.

## Why the fix is not "defer the persist read"

Two alternatives look cheaper and are not:

- **Make `usePersisted` async on the client.** It would fix the first render and break every consumer that reads the value during construction, which is the API's whole point. The adapter already supports an async `get` for exactly the stores that need it; forcing it on `localStorage` makes the common case worse to fix the rarer one.
- **Skip `usePersisted` on the server.** It already no-ops there — `localStorageAdapter.get` returns `null` when `typeof localStorage === 'undefined'`. The mismatch is not the server reading something it should not; it is the client reading something the server could not.

## Detecting it

`packages/react/tests/ssr-hydration.test.tsx` shows the shape of a test that would catch it: `renderToString`, then `hydrateRoot` over that HTML with an `onRecoverableError` collector, and assert the collector stays empty. A test for this pitfall specifically has to seed the adapter before building the client root — otherwise both sides start from the defaults and agree.
