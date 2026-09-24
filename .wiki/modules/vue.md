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
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-vue`

The Vue 3 adapter, one file (`packages/vue/src/index.ts`). The root is built outside Vue and installed with `app.use(olasPlugin(root))`, which `provide`s it under a private `InjectionKey`. Vue owns no controller's lifetime.

## Public surface

```ts
olasPlugin(root: Root<unknown>): { install(app: App): void }
useRoot<Api = RegisteredApi>(): Api        // root.api; throws with the fix when no plugin provided one
useValue<T>(signal, { isEqual? }): Readonly<Ref<T>>
useQuery<T>(sub: AsyncState<T>): UseQueryReturn<T>              // a ref per signal + refetch/reset/cancel
useInfiniteQuery<P, I>(sub): UseInfiniteQueryReturn<P, I>       // + pages, flat, paging flags and actions
useField<T>(field: Field<T>): UseFieldReturn<T>                 // `value` is a WritableComputedRef for v-model
useMutation<V, R>(m: Mutation<V, R>): UseMutationReturn<V, R>   // refs + mutate (void) / run (promise) / reset
interface Register {}                                           // augmented by the app: { root: typeof root }
```

## `useValue`

Everything else is built from it, through `valueRef`, which is `useValue` without the scope check.
- A `customRef` whose getter calls `track()` and returns `signal.peek()`. A read therefore sees a write at once, before Vue flushes.
- One `subscribeChanges` subscription calls the ref's `trigger()` when the value moves and `isEqual` (default `Object.is`) calls it a change.
- `onScopeDispose` ends the subscription with the current effect scope. Outside a scope, the ref still works and nothing ends it.
- The ref's `set` ignores the write. `useField`'s `value` is a separate `computed` whose setter calls `field.set`.

## Outside an effect scope

Called from a plain module or a `setTimeout`, a hook has no scope to end its subscriptions. `getCurrentScope()` is `undefined`, the refs still work, and the signals keep the refs' trigger closures alive for as long as the signals live.

Each public hook checks for a scope first, as `__DEV__ && warnOutsideScope(name)`. The expression form is on purpose. The package has about twenty branches, and five `if (__DEV__)` guards put it under the 90% branch gate. Their production side cannot run under the `__DEV__: 'true'` that `vitest.config.ts` defines. The default build drops the expression either way. It warns once per hook name, naming the hook, the leak and the fix: `setup()`, or `effectScope().run()` and a later `stop()`. The hooks built on another call `valueRef` and `queryRefs` rather than `useValue` and `useQuery`, so `useQuery` warns as `useQuery`, not ten times as `useValue`. `useRoot` subscribes to nothing, so it does not check.

The package ships two builds for this, like core and react (SPEC §23). `dist/` inlines `__DEV__ = false` and drops the check with the `Set` behind it. `dist/dev/` sits behind the `development` export condition and keeps it. `packages/vue/tests/scope-warning.test.ts` runs in a file of its own, since the once-per-hook memory is module state.

## Granularity

`useQuery` returns ten independent refs, so Vue re-renders a template only for the refs it read. React needs tracked getters for the same effect (`react.md`); Vue's own tracking provides it.

## `useMutation`

`run` calls `mutation.run`. `mutate` calls `run` and catches the rejection, so a failed run lands on `error` and `status` and does not become an unhandled rejection. It keeps the last success's `data`, as core does.

## Tests

- `packages/vue/tests/vue.test.ts` mounts components with `createApp` in jsdom and covers every hook, the missing-plugin error, unsubscribe on unmount, `isEqual`, and the read-only ref.
- `packages/vue/tests/register.test-d.ts` pins the `Register` augmentation at the type level.
- `packages/integration/tests/adapter-parity/vue.test.ts` runs the shared scenarios.
- `examples/vue-tasks` is the example app.
