---
name: vue
description: "@kontsedal/olas-vue — olasPlugin, useRoot, useValue, useQuery, useInfiniteQuery, useField, useMutation. Signals as read-only refs."
type: module
covers:
  - packages/vue/src/index.ts
  - packages/vue/tsdown.config.ts
edges:
  - { type: tested-by, target: ../../packages/vue/tests/vue.test.ts }
  - { type: tested-by, target: ../../packages/vue/tests/scope-warning.test.ts }
  - { type: tested-by, target: ../../packages/integration/tests/adapter-parity/vue.test.ts }
  - { type: uses, target: signals.md }
  - { type: related, target: ../decisions/framework-adapters.md }
  - { type: related, target: react.md }
  - { type: related, target: ../pitfalls/bind-mutates-in-place.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-vue`

The Vue 3 adapter, one file (`packages/vue/src/index.ts`). The root is built outside Vue and installed with `app.use(olasPlugin(root))`, which `provide`s it under a private `InjectionKey`. Vue owns no controller's lifetime.

## Public surface

```ts
olasPlugin(root: Root<unknown>): { install(app: App): void }
useRoot<Api = RegisteredApi>(): Api        // root.api; throws with the fix when no plugin provided one, or outside setup()
useValue<T>(signal, { isEqual? }): Readonly<Ref<T>>
useQuery<T>(sub: AsyncState<T>): UseQueryReturn<T>              // a ref per signal + refetch/reset/cancel
useInfiniteQuery<P, I>(sub): UseInfiniteQueryReturn<P, I>       // + pages, flat, paging flags and actions
useField<T>(field: Field<T>): UseFieldReturn<T>                 // `value` is a writable Ref<T> for v-model
useMutation<V, R>(m: Mutation<V, R>): UseMutationReturn<V, R>   // refs + mutate (void) / run (promise) / reset
interface Register {}                                           // augmented by the app: { root: typeof root }
```

## `useValue`

Everything else is built from it, through `valueRef` (`packages/vue/src/index.ts:142-183`), which is `useValue` without the scope check.
- A `customRef` whose getter calls `track()` and reads `signal.peek()`. A read therefore sees a write at once, before Vue flushes.
- The getter returns `shown`, the value it last returned, while `isEqual` calls the current one equal to it. That is React's `useValue`: `isEqual` means "unchanged, keep the previous value". With the default `Object.is`, `shown` follows every write. Before the 2026-09-25 review the getter returned `signal.peek()` whatever `isEqual` said, so a component that re-rendered for another reason showed the new value: `user.set({ id: 1, name: 'B' })` equal by id, then an unrelated re-render, read `B:1` in Vue and `A:1` in React.
- One `subscribeChanges` subscription calls the ref's `trigger()` when `isEqual` calls the new value a change from `seen`, the value it last triggered for. `seen` is kept apart from `shown` because a read inside a `batch` moves `shown` before the notification arrives, and that notification must still trigger.
- `onScopeDispose` ends the subscription with the current effect scope. Outside a scope, the ref still works and nothing ends it.
- The ref's `set` ignores the write unless the hook passes `write`. `useField`'s `value` is `valueRef(field, undefined, (next) => field.set(next))`, so it reads `field.peek()` like every other ref and writes through `field.set`.

`v-model="value.name"` on an object-valued field does not go through that setter. Vue assigns `name` on the object the getter returned, the field's own value, so nothing calls `field.set` and no validator runs. The field's baseline is a copy of its own since 1.0, so `reset()` still restores. The adapter cannot see the assignment. SPEC §16.2 names the workaround, a writable `computed` that calls `set` with a new object, and `../pitfalls/bind-mutates-in-place.md` has the Svelte half.

The `value` was a Vue `computed` over the field's ref until the 1.0 review. A `computed` caches, and the ref beneath it is marked stale only when a `batch` ends. So inside a `batch`, after `field.set('b')`, `value.value` still read `'a'`. The `customRef` reads the field on every access, and SPEC §16.2 promises exactly that: a write is visible to the next read before Vue flushes.

## Server render

Vue never stops a component's effect scope on the server, so `onScopeDispose` never fires there. A subscription made during `renderToString` would outlive the request, one per ref per render. `valueRef` subscribes only when `hasInjectionContext() && inject(ssrContextKey, null)` finds no server-render context. `renderToString` and the stream renderers provide `ssrContextKey` on the app, so a server-rendered component sees it, and a client component, a hydrating one included, does not. Outside any component, `hasInjectionContext()` is false and the ref subscribes as before. `useSSRContext()` would have done the same lookup, but it warns on the client when the context is missing.

The server reads each ref once, through `signal.peek()`, so the refs render the current values. React's `useSyncExternalStore` does not subscribe on the server either, and Svelte unsubscribes at the end of a server render.

## Outside an effect scope

Called from a plain module or a `setTimeout`, a hook has no scope to end its subscriptions. `getCurrentScope()` is `undefined`, the refs still work, and the signals keep the refs' trigger closures alive for as long as the signals live.

Each public hook checks for a scope first, as `__DEV__ && warnOutsideScope(name)`. The expression form is on purpose. The package has about twenty branches, and five `if (__DEV__)` guards put it under the 90% branch gate. Their production side cannot run under the `__DEV__: 'true'` that `vitest.config.ts` defines. The default build drops the expression either way. It warns once per hook name, naming the hook, the leak and the fix: `setup()`, or `effectScope().run()` and a later `stop()`. The hooks built on another call `valueRef` and `queryRefs` rather than `useValue` and `useQuery`, so `useQuery` warns as `useQuery`, not ten times as `useValue`. `useRoot` subscribes to nothing, so it does not check. It checks `hasInjectionContext()` before `inject`, though: outside an injection context `inject` returns `undefined`, not the `null` default, and warns. The `=== null` guard missed that and the next line threw `TypeError: Cannot read properties of undefined (reading 'api')`. Both cases now throw `[olas] useRoot() found no root`, with the cause: no plugin, or a call outside `setup()` and `app.runWithContext()`.

The package ships two builds for this, like core and react (SPEC §23). `dist/` inlines `__DEV__ = false` and drops the check with the `Set` behind it. `dist/dev/` sits behind the `development` export condition and keeps it. `packages/vue/tests/scope-warning.test.ts` runs in a file of its own, since the once-per-hook memory is module state.

## Granularity

`useQuery` returns ten independent refs, so Vue re-renders a template only for the refs it read. React needs tracked getters for the same effect (`react.md`); Vue's own tracking provides it.

## `useMutation`

`run` calls `mutation.run`. `mutate` calls `run` and catches the rejection, so a failed run lands on `error` and `status` and does not become an unhandled rejection. It keeps the last success's `data`, as core does.

## Tests

- `packages/vue/tests/vue.test.ts` mounts components with `createApp` in jsdom and covers every hook, the missing-plugin error, `useRoot` outside `setup()`, unsubscribe on unmount, `isEqual` for triggering and for the value shown, and the read-only ref. "value reads a write at once, inside a batch too" pins `useField`'s `value`. "a server render reads each signal and leaves no subscription behind" renders three times with `renderToString` and counts live subscriptions.
- `packages/vue/tests/register.test-d.ts` pins the `Register` augmentation at the type level.
- `packages/integration/tests/adapter-parity/vue.test.ts` runs the shared scenarios, `isEqual` keeping the value shown among them.
- `examples/vue-tasks` is the example app.
