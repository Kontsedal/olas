---
name: use-root
description: Root is constructed once outside React, provided via context, resolved by hooks, and read via useSyncExternalStore-backed subscriptions.
type: flow
covers:
  - packages/react/src/context.ts
  - packages/react/src/hooks.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/react/tests/adapter.test.tsx }
  - { type: uses, target: ../modules/react.md }
  - { type: uses, target: ../entities/controller-instance.md }
last_verified: 2026-09-24
confidence: medium
---

# Flow — Root → Provider → Hook → DOM

The full path from `createRoot(...)` at app entry to a value rendered in a React component. Spec §16.

```
main.tsx
  const root = createRoot(appController, { deps })          ─┐
  <OlasProvider root={root}>                                  │ outside React
    <App />                                                   │
  </OlasProvider>                                             ─┘

inside any component
  const api = useRoot<AppApi>()             // <─ Context.useContext
  const value = useValue(api.someSignal)    // <─ useSyncExternalStore
  return <span>{value}</span>
```

## Step by step

1. **`createRoot(def, { deps })`** runs the controller factory exactly once, constructs the `ControllerInstance`, and attaches the lifecycle controls. The returned `Root<Api>` is a frozen handle: the app's api on `root.api`, the controls (`dispose`, `suspend`, `resume`, `dehydrate`, `hydrate`, `waitForIdle`, `bindQuery`, `inject`, `debug`) beside it. See `entities/controller-instance.md` and `decisions/root-handle-separate.md`.

2. **`<OlasProvider root={root}>`** is a one-line React Context provider. The context's default value is `null`. No setup work happens inside React — the root already exists.

3. **`useRoot()`** reads `useContext(OlasContext)` and returns `root.api` (`packages/react/src/context.ts:35-41`). If the context is null (missing provider), it throws `[olas] useRoot() called outside <OlasProvider>` — catches the common "forgot to wrap" mistake. Cast through generics to the app's API type: `useRoot<AppApi>()`. The cast is required because the context's runtime type is `Root<unknown>` — we don't know the api shape at context-definition time.

4. **`useValue(signal)`** wraps `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`:
   - `subscribe(onChange)` goes through the signal's `subscribeChanges`, which skips the synchronous initial fire (see `modules/react.md`'s subscription section).
   - `getSnapshot()` returns `signal.peek()` — untracked read, no auto-tracking.
   - The third arg (`getServerSnapshot`) is the same function; the snapshot read in SSR must match the client.

5. **React re-renders** whenever any subscribed snapshot changes. Olas signals dedupe (Object.is) before notifying, so a `signal.set(x)` with `x === current` is a no-op.

## Concurrent rendering and StrictMode

`useSyncExternalStore` is built for React 18 concurrent mode — it guarantees no tearing across concurrent renders. The adapter inherits that property for free.

StrictMode in dev runs each effect twice. For pure subscription hooks (`useValue`, `useQuery`, `useField`) this means: subscribe → unsubscribe → subscribe. The second subscribe is fresh; no state leaks across the cycle.

The controller tree is unaffected by StrictMode because it lives outside React. The factory ran once, in `createRoot`. See `adapter.test.tsx`'s "double-mount does not double-construct" test.

## Several roots

`useRoot()` reads one context. An app with several unrelated roots gets a typed pair per root from `createOlasContext<Api>(displayName)`, which returns `{ Provider, useRoot, Context }`. A component outside a provider can read `root.api` directly, since the root is a plain object. `useController(root)` was the identity function for that case, and 1.0 removed it.

## Failure modes

- **Missing `<OlasProvider>`**: `useRoot()` throws synchronously.
- **Wrong API type cast**: `useRoot<WrongType>()` compiles but reads will return undefined at runtime. Mitigation: define the cast once near `main.tsx` and import.
- **Root disposed while React still mounted**: `signal.subscribe(...)` returns a no-op unsubscribe after dispose; reads continue but never update. Pattern: only call `root.dispose()` after React has unmounted (or never, if the root outlives the app).
