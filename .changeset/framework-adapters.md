---
"@kontsedal/olas-vue": major
"@kontsedal/olas-svelte": major
"@kontsedal/olas-react": minor
---

**Vue and Svelte adapters; React gains `useInfiniteQuery`, a fine-grained `useQuery`, and verified Preact support.**

**New: `@kontsedal/olas-vue`.**
- `app.use(olasPlugin(root))` provides a root to the app, and `useRoot()` reads its api, typed through an augmented `Register`.
- `useValue(signal)` returns a read-only ref over any `ReadSignal`. A read sees a write at once, and the subscription ends with the component's effect scope.
- `useQuery`, `useInfiniteQuery`, `useField` and `useMutation` return one ref per signal plus the target's actions. `useField`'s `value` is writable, for `v-model`. `useMutation`'s `mutate` is fire-and-forget, and `run` returns the promise.

**New: `@kontsedal/olas-svelte`.**
- An Olas signal already satisfies Svelte's store contract, so `$count` works on a signal with no wrapper. A `Field` is a writable store, so `bind:value={$name}` writes through `field.set`.
- `setRoot(root)` and `getRoot()` carry the root through Svelte context, typed through an augmented `Register`.
- `queryStore`, `infiniteQueryStore`, `fieldStore` and `mutationStore` give one store per multi-signal object, with its actions.

**react.**
- New `useInfiniteQuery(subscription, { suspense? })`. One subscription covers `pages`, `flat`, the paging flags, `fetchNextPage` and `fetchPreviousPage`.
- `useQuery` re-renders only for the fields a component reads. `const { data } = useQuery(sub)` no longer re-renders when a background refetch flips `isFetching`. A field read in an event handler or an effect returns its current value, and until anything is read, every change re-renders as before.
- `useValue`'s `isEqual` now keeps the previous reference across an inline selector, which is a new function on every render.
- The adapter runs under `preact/compat`. Alias `react` to it the way a Preact app does. The provider, every hook, `Suspense` and `SuspendOnUnmount` are tested there; `HydrationBoundary`'s StrictMode handling is not, because compat's `StrictMode` does nothing.

One set of scenarios runs through React, `preact/compat`, Vue and Svelte, and each adapter renders the same DOM for it.
