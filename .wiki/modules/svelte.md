---
name: svelte
description: "@kontsedal/olas-svelte — setRoot/getRoot plus queryStore, infiniteQueryStore, fieldStore and mutationStore. Olas signals are Svelte stores as they are."
type: module
covers:
  - packages/svelte/src/index.ts
edges:
  - { type: tested-by, target: ../../packages/svelte/tests/svelte.test.ts }
  - { type: tested-by, target: ../../packages/integration/tests/adapter-parity/svelte.test.ts }
  - { type: uses, target: signals.md }
  - { type: related, target: ../decisions/framework-adapters.md }
last_verified: 2026-09-24
confidence: medium
---

# `@kontsedal/olas-svelte`

The Svelte adapter, one file (`packages/svelte/src/index.ts`). It is the smallest of the three because Svelte's store contract is what an Olas signal already is.

## Signals are stores

Svelte's contract is `subscribe(run)` that calls `run` with the current value at once and on every change, and returns the unsubscribe. `ReadSignal.subscribe` does exactly that. So `$count` works on a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray`, and Svelte subscribes on mount and unsubscribes on destroy. A `Field` also has `set`, so it is a writable store and `bind:value={$name}` writes through `field.set`.

## Public surface

```ts
setRoot(root: Root<unknown>): void          // setContext under a private symbol; call during component init
getRoot<Api = RegisteredApi>(): Api         // root.api from the nearest setRoot; throws with the fix otherwise
queryStore<T>(sub: AsyncState<T>): QueryStore<T>
infiniteQueryStore<P, I>(sub): InfiniteQueryStore<P, I>
fieldStore<T>(field: Field<T>): FieldStore<T>
mutationStore<V, R>(m: Mutation<V, R>): MutationStore<V, R>
interface Register {}                        // augmented by the app: { root: typeof root }
```

Each `…Store` is a `ReadSignal` of a plain state object, built as one core `computed` over every signal of its target, with the target's actions beside it (`withActions`). One `computed` means a `batch` of writes reaches the component as one store update.

`mutationStore`'s `mutate` catches the rejection, like the other two adapters.

## Testing it

Component tests need two things the rest of the suite must not get:
- the Svelte compiler plugin (`@sveltejs/vite-plugin-svelte`);
- the `browser` resolve condition, without which `svelte` resolves to its server build and `mount` throws.

The root `vitest.config.ts` runs them as a separate `svelte` project for that reason (`decisions/framework-adapters.md`). Fixtures are `.svelte` files in `packages/svelte/tests/fixtures/`. `Harness.svelte` calls `setRoot` and renders the view under test. Svelte ships the `*.svelte` module declaration, so `tsc` typechecks the test files without a shim; the `.svelte` files themselves are checked only by the compiler, at test time.

## Tests

- `packages/svelte/tests/svelte.test.ts` covers the store contract in a real component, the missing-root error, unsubscribe on unmount, `bind:value` on a field, each store's actions, and `mutate` swallowing the rejection.
- `packages/svelte/tests/register.test-d.ts` pins the `Register` augmentation.
- `packages/integration/tests/adapter-parity/svelte.test.ts` runs the shared scenarios.
