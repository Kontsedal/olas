# @kontsedal/olas-vue

## 1.0.1

### Patch Changes

- e5f9834: **`useValue`'s `isEqual` keeps the value it showed, as in React, and `useRoot()` outside `setup()` throws an olas message.**
  
  With `isEqual`, a write that `isEqual` called equal did not trigger the component, but the ref's getter read the signal's current value. A component that re-rendered for another reason then showed the new value, where React's `useValue` keeps the previous one. The ref now keeps returning the value it last returned while `isEqual` calls the new one equal to it. The adapter-parity suite runs the case through React, Preact and Vue.
  
  `useRoot()` called outside a component's `setup()` threw `TypeError: Cannot read properties of undefined (reading 'api')`, because Vue's `inject` returns `undefined` there, not the default. It now throws `[olas] useRoot() found no root`, naming `setup()` and `app.runWithContext()`, without Vue's own warning.

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

### Minor Changes

- 50a12c1: **A development build, which warns when a hook runs outside an effect scope.**
  
  Each hook ends its signal subscriptions through `onScopeDispose`. A hook can also run outside any effect scope, from a plain module or a `setTimeout`. It still returns working refs there, but nothing ends their subscriptions. They stay live, and keep the refs in memory, for as long as the signals exist.
  
  A development build now warns about it where it happens, once per hook. The warning names the hook and the leak. It also names the fix: call the hook from a component's `setup()`, or inside `effectScope().run()` and `stop()` the scope when you are done. `useQuery` warns as `useQuery`, not once per ref it builds.
  
  For this the package ships two builds, as core and react do. `dist/` is the default, a production build with the warning stripped. `dist/dev/` sits behind the `development` export condition, which Vite's dev server, webpack, Rspack and Next.js resolve in development. The default build keeps its behaviour. It grows by 12 bytes brotlied, from the internal helpers the hooks now share, and stays inside its budget.

### Patch Changes

- b89d091: **A server render leaves no subscription behind, and `useField(field).value` reads a write inside a `batch`.**
  
  Vue never stops a component's effect scope on the server, so every ref a hook made during `renderToString` stayed subscribed after the request. During a server render, the refs now read their signals and subscribe to nothing. The adapter detects the render through Vue's `ssrContextKey`, which the server renderer provides.
  
  `useField(field).value` was a Vue `computed`, which cached the field's value until a `batch` ended. Inside a `batch`, after `field.set('b')`, it still read the old value. It is now a ref that reads the field on every access, like the other refs, and still writes through `field.set` for `v-model`. Its type is `Ref<T>` instead of `WritableComputedRef<T>`.
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
