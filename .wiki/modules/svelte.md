---
name: svelte
description: "@kontsedal/olas-svelte — setRoot/getRoot plus queryStore, infiniteQueryStore, fieldStore and mutationStore. Olas signals are Svelte stores as they are."
type: module
covers:
  - packages/svelte/src/index.ts
  - packages/svelte/package.json
  - packages/svelte/tsconfig.svelte-check.json
edges:
  - { type: tested-by, target: ../../packages/svelte/tests/svelte.test.ts }
  - { type: tested-by, target: ../../packages/integration/tests/adapter-parity/svelte.test.ts }
  - { type: uses, target: signals.md }
  - { type: related, target: ../decisions/framework-adapters.md }
  - { type: related, target: ../pitfalls/bind-mutates-in-place.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-svelte`

The Svelte adapter, one file (`packages/svelte/src/index.ts`). It is the smallest of the three because Svelte's store contract is what an Olas signal already is.

## Signals are stores

Svelte's contract is `subscribe(run)` that calls `run` with the current value at once and on every change, and returns the unsubscribe. `ReadSignal.subscribe` does exactly that. So `$count` works on a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray`, and Svelte subscribes on mount and unsubscribes on destroy. A `Field` also has `set`, so it is a writable store and `bind:value={$name}` writes through `field.set`.

## Binding a `fieldStore` member

`fieldStore` also has `set`, so Svelte treats it as writable too. For `bind:value={$state.value}`, Svelte 4 and 5 compile the write the same way: assign `value` on the object the store last handed the component, then call `store.set(thatObject)`. Two things went wrong before the 1.0 review. `set` passed the whole state object to `field.set`, so typing "ab" left the field holding `{ value: 'ab', errors: [], … }`. And the object Svelte assigned into was the core `computed`'s cached value.

`fieldStore` now replaces the store's `subscribe`. Each call hands the subscriber a shallow copy of the state and records the copy in a `WeakSet`. `set` writes `copy.value` when its argument is a recorded copy, and passes anything else to `field.set` unchanged. A copy is never a valid field value, so the check cannot misread a field whose value is itself an object with a `value` key. `peek()` and `value` still return the `computed`'s own object. `FieldStore.set` keeps its `(value: T) => void` type, since only Svelte passes the state object.

## A nested bind on an object value (2026-09-25 review)

`bind:value={$person.value.first}` goes one level deeper: Svelte assigns `first` on `copy.value` and then calls `set(copy)`. The state copy was shallow, so `copy.value` was the field's own value object, which is also its `initial` until the first write. The assignment edited both in place, and `field.set(sameObject)` was no change to the signal: no validator ran, `isDirty` stayed `false`, and `reset()` returned the edited value. `copyValue` (`packages/svelte/src/index.ts:180-194`) now puts a shallow copy of a plain-object or array value into each state copy, so the assignment lands on the copy and `set` writes a new value. A null-prototype object keeps its prototype, and anything else, such as a `Date`, goes out as it is. A member two levels down lands on the field's own value object. Since 1.0 the field still hears it, because core counts a `set` of the held object as a change, and its baseline is a copy of its own (`forms.md`, "An object value edited in place"). The same holds for a raw `Field` bound as `bind:value={$person.first}`.

A raw `Field` bound as `bind:value={$person.first}` keeps the old behavior. Svelte calls the field's own `subscribe` and `set` there, with no adapter code in between, so the fix would belong in core (`../pitfalls/bind-mutates-in-place.md`). SPEC §16.3 tells the app to bind an object's members through `fieldStore`.

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

The root `vitest.config.ts` runs them as a separate `svelte` project for that reason (`decisions/framework-adapters.md`). Fixtures are `.svelte` files in `packages/svelte/tests/fixtures/`. `Harness.svelte` calls `setRoot` and renders the view under test. Svelte ships the `*.svelte` module declaration, so `tsc` typechecks the test files without a shim. `tsc` cannot see inside a `.svelte` file, though, and the compiler strips its types at test time without checking them. So the package's `typecheck` script runs `svelte-check --tsconfig ./tsconfig.svelte-check.json --fail-on-warnings` after `tsc`. That config includes these fixtures and the parity views in `packages/integration/tests/adapter-parity/svelte/`, with `rootDir` widened to `packages/` for the second directory.

The first run found no type errors and one warning, twice: `state_referenced_locally` on `setRoot(root)` in `Harness.svelte` and the parity `App.svelte`. Reading the `root` prop once is the intent, since a context is set while the component initializes. Both files carry a `svelte-ignore` comment that says so.

## Tests

- `packages/svelte/tests/svelte.test.ts` covers the store contract in a real component, the missing-root error, unsubscribe on unmount, `bind:value` on a field, each store's actions, and `mutate` swallowing the rejection. "bind:value on a fieldStore member writes the value, not the state object" types into `FieldMember.svelte`. "a member write leaves the store’s own state object untouched" replays Svelte's assign-then-`set` by hand. "a nested bind on an object-valued fieldStore writes a new value and leaves initial alone" types into `FieldObject.svelte`.
- `packages/svelte/tests/register.test-d.ts` pins the `Register` augmentation.
- `packages/integration/tests/adapter-parity/svelte.test.ts` runs the shared scenarios. It declares `lacks: ['equal']`: a signal is a Svelte store as it is, with no `isEqual` to pass, so the `isEqual` scenario is skipped for Svelte.
