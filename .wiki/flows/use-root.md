---
name: use-root
description: The root is built once outside React as a handle, provided through context, resolved by useRoot() to root.api (typed by the augmented Register), and read through useSyncExternalStore-backed hooks.
type: flow
covers:
  - packages/react/src/context.ts:14-116
  - packages/react/src/hooks.ts:24-135
  - packages/core/src/controller/root.ts:114-246
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/react/tests/adapter.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/register.test-d.tsx }
  - { type: tested-by, target: ../../packages/react/tests/field-input-and-context.test.tsx }
  - { type: uses, target: ../modules/react.md }
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: related, target: ../decisions/root-handle-separate.md }
  - { type: related, target: ../decisions/typed-use-root.md }
last_verified: 2026-09-25
confidence: high
---

# Flow — Root → Provider → Hook → DOM

The full path from `createRoot(...)` at app entry to a value rendered in a React component. Spec §16.

```
main.tsx
  const root = createRoot(appController, { deps, queries: queryEngine() })   ─┐
  declare module '@kontsedal/olas-react' {                                      │
    interface Register { root: typeof root }                                    │ outside React
  }                                                                             │
  <OlasProvider root={root}><App /></OlasProvider>                             ─┘

inside any component
  const api = useRoot()                     // <─ useContext → root.api, typed by Register
  const value = useValue(api.someSignal)    // <─ useSyncExternalStore
  return <span>{value}</span>
```

## Step by step

1. **`createRoot(def, options)`** runs the controller factory exactly once and returns a frozen `Root<Api>` handle (`packages/core/src/controller/root.ts:191-229`). The app's api is on `root.api`, and the controls sit beside it: `dispose`, `suspend`, `resume`, `dehydrate`, `hydrate`, `waitForIdle`, `bindQuery`, `inject` and `debug`. See `../entities/controller-instance.md` and `../decisions/root-handle-separate.md`.

2. **`<OlasProvider root={root}>`** is a one-line React Context provider (`packages/react/src/context.ts:23-27`). The context's default value is `null`. No setup work happens inside React, because the root already exists.

3. **`useRoot()`** reads `useContext(OlasContext)` and returns `root.api` (`context.ts:59-65`). With the context `null`, meaning no provider, it throws `[olas] useRoot() called outside <OlasProvider>`, which catches the common "forgot to wrap" mistake. The return type is `RegisteredApi` (`context.ts:44-47`): the api of the root the app registered through `interface Register { root: typeof root }`, else `unknown`. An app that does not register names the type per call, `useRoot<AppApi>()`, as an unchecked cast. The reasoning is in `../decisions/typed-use-root.md`, and `register.test-d.tsx` pins the augmentation. The kanban example registers its root, which proves the merge against the built `.d.ts`.

4. **`useValue(signal, options?)`** wraps `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)` (`packages/react/src/hooks.ts:83-135`):
   - `subscribe(onChange)` goes through the signal's `subscribeChanges`, which skips the synchronous initial fire (`hooks.ts:37-39`; see `../modules/react.md`'s subscription section).
   - `getSnapshot()` reads `signal.peek()`, an untracked read, and applies `select` when given. It caches the last result, so it returns the same reference until the raw value, the selector or `isEqual`'s verdict changes.
   - The third argument, `getServerSnapshot`, is the same function, so the snapshot read during SSR matches the client.

5. **React re-renders** when a subscribed snapshot changes. Olas signals dedupe with `Object.is` before notifying, so a `signal.set(x)` with `x === current` notifies no subscriber.

## Concurrent rendering and StrictMode

`useSyncExternalStore` is built for React 18 concurrent mode, and it guarantees no tearing across concurrent renders. The adapter inherits that property.

StrictMode in development runs each effect twice. For the subscription hooks (`useValue`, `useQuery`, `useField`) that means subscribe → unsubscribe → subscribe. The second subscribe is fresh, and no state leaks across the cycle.

The controller tree is unaffected by StrictMode because it lives outside React: the factory ran once, in `createRoot`. See `adapter.test.tsx`, "double-mount does not double-construct the controller". `HydrationBoundary` is the one component that creates a root inside React, and it guards against StrictMode itself; see `../modules/react.md`.

## Several roots

`useRoot()` reads one context. An app with several unrelated roots gets a typed pair per root from `createOlasContext<Api>(displayName)`, which returns `{ Provider, useRoot, Context }` (`context.ts:91-116`). Pinned by `field-input-and-context.test.tsx`. A component outside a provider reads `root.api` directly, since the root is a plain object. `useController(root)` was the identity function for that case, and 1.0 removed it.

## Failure modes

- **Missing `<OlasProvider>`**: `useRoot()` throws synchronously. Pinned by `adapter.test.tsx`, "useRoot throws outside <OlasProvider>".
- **Wrong type argument**: without a `Register` entry, `useRoot<WrongType>()` compiles, and reads return `undefined` at runtime. Register the root once, next to `createRoot`, and call `useRoot()` with no argument.
- **Root disposed while React is still mounted**: the components keep their subscriptions, and the signals keep their last values. The effects, fetches and timers that drove them are gone, so the screen stops updating without an error. Dispose the root only after React has unmounted, or never, when the root lives as long as the app.
