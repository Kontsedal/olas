---
name: typed-use-root
description: Why `useRoot()` is typed through a `Register` interface the app augments once, and why `createOlasContext` and `useFieldInput` stay in 1.0.
type: decision
covers:
  - packages/react/src/context.ts
  - packages/react/src/hooks.ts
  - examples/kanban/src/root.ts
  - examples/reader-ssr/src/Composer.tsx
edges:
  - { type: tested-by, target: ../../packages/react/tests/register.test-d.tsx }
  - { type: tested-by, target: ../../packages/react/tests/field-input-and-context.test.tsx }
  - { type: uses, target: ../modules/react.md }
last_verified: 2026-09-25
confidence: medium
---

# A typed `useRoot()`, and two hooks kept

## `useRoot()` reads a registered root type

`useRoot<Api = RegisteredApi>()` returns the api of the root the app registered (`packages/react/src/context.ts`):

```ts
const root = createRoot(appController, { deps })

declare module '@kontsedal/olas-react' {
  interface Register {
    root: typeof root
  }
}

const api = useRoot()   // typed, no argument
```

`Register` is empty in the package. `RegisteredApi` is `Register extends { root: Root<infer Api> } ? Api : unknown`.

Before 1.0, every call site wrote `useRoot<AppApi>()`, an unchecked cast repeated at each call: the kanban example had 17 of them. One registration makes the cast checked once, at the root's declaration. An explicit type argument still wins.

TanStack Router and Query use the same pattern. It is the only way a hook can know an app-level type without a generic at every call site.

The augmentation is checked from both sides:
- `packages/react/tests/register.test-d.tsx` is a type-level test, run by the package's `tsc`.
- The kanban example registers its root in `examples/kanban/src/root.ts` and typechecks against the built `.d.ts`. So the merge is proven against what consumers install, not only against `src`.

## `createOlasContext` stays, for several roots

`Register` names one root. An app with several unrelated roots, such as an auth shell and a workspace app, still needs a typed provider per root. `createOlasContext<Api>(displayName)` returns `{ Provider, useRoot, Context }`, and its `useRoot` throws naming `displayName` outside its provider.

It had no test and no consumer before 1.0, which a BACKLOG item flagged. It now has tests in `packages/react/tests/field-input-and-context.test.tsx`.

## `useFieldInput` stays, and an example uses it

`useFieldInput(field, { transform?, name? })` returns `value`, `onChange`, `onBlur`, `name` and `aria-invalid` for a native input. `aria-invalid` is set only once the field is touched and has errors. The handler identities are keyed on the field alone, so an inline `transform` literal does not churn them.

The four examples all hand-rolled those props, which argued for the hook rather than against it. The reader-ssr Composer's author input now spreads it (`examples/reader-ssr/src/Composer.tsx`). The same tests file covers binding, `transform` and handler identity.
