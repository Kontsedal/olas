# @kontsedal/olas-svelte

## 1.0.1

### Patch Changes

- e5f9834: **A nested bind on an object-valued `fieldStore`, `bind:value={$person.value.first}`, writes the field and leaves its `initial` alone.**
  
  Svelte writes that bind by assigning `first` on the object the store handed out, then passing the state back to `set`. `fieldStore` handed out the field's own value object, which is also its `initial` until the first write. So the assignment changed `initial` in place, and `set` passed the same object back, which is no change to a signal. No validator ran, `isDirty` stayed `false`, and `reset()` gave back the edited value. Each subscriber now gets a shallow copy of a plain-object or array value, so `set` writes a new value. A member two levels down is still shared with the field's value. A raw `Field` bound the same way, `bind:value={$person.first}`, is fixed in core: see the `@kontsedal/olas-core` changeset on setting an object in place.

## 1.0.0

### Major Changes

- 06b715f: **Vue and Svelte adapters; React gains `useInfiniteQuery`, a fine-grained `useQuery`, and verified Preact support.**
  
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

### Patch Changes

- b89d091: **`bind:value={$state.value}` on a `fieldStore` writes the field's value.**
  
  Svelte writes a member binding by assigning the member on the value the store handed it, then passing that whole value to `set`. `fieldStore`'s `set` sent it to `field.set` as it was, so typing "ab" left the field holding `{ value: 'ab', errors: [], … }`. Svelte also assigned into the core `computed`'s cached state object. `fieldStore` now hands each subscriber its own copy of the state, and `set` writes a copy's `value` to the field. A plain value still goes to `field.set` unchanged.
- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- Updated dependencies [beab02a]
- Updated dependencies [f9b34a7]
- Updated dependencies [d5642d5]
- Updated dependencies [ae18408]
- Updated dependencies [008d8ef]
- Updated dependencies [008d8ef]
- Updated dependencies [1c6964e]
- Updated dependencies [360120c]
- Updated dependencies [a2b8b14]
- Updated dependencies [008d8ef]
- Updated dependencies [325ecf3]
- Updated dependencies [6e154ef]
- Updated dependencies [153261f]
- Updated dependencies [518f5d9]
- Updated dependencies [af217d0]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [cdb6b77]
- Updated dependencies [cdb6b77]
- Updated dependencies [cdb6b77]
- Updated dependencies [008d8ef]
- Updated dependencies [cdb6b77]
- Updated dependencies [3d95f3c]
- Updated dependencies [fea5505]
- Updated dependencies [cb08097]
- Updated dependencies [b0f1c41]
- Updated dependencies [325ecf3]
- Updated dependencies [a328f3a]
- Updated dependencies [a328f3a]
- Updated dependencies [8aaf0e7]
- Updated dependencies [d0b11ef]
- Updated dependencies [023eaf3]
- Updated dependencies [0ce21f3]
- Updated dependencies [2174dce]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [325ecf3]
- Updated dependencies [a29b4ea]
- Updated dependencies [3f9b98d]
- Updated dependencies [20473ba]
- Updated dependencies [1299818]
- Updated dependencies [38cf416]
- Updated dependencies [4c47f81]
- Updated dependencies [38cf416]
- Updated dependencies [02b45f2]
  - @kontsedal/olas-core@1.0.0
