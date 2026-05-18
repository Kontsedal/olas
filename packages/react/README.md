# @olas/react

The React adapter for [Olas](../..). Tiny binding layer (~230 LOC) on top of `useSyncExternalStore`. The root is created **outside** React and resolved via context — so React never owns the controller lifetime, no double-construction under StrictMode, and concurrent rendering is safe by construction.

## Install

```bash
pnpm add @olas/react @olas/core @preact/signals-core react react-dom
```

`react >= 18` is a peer dep (we rely on `useSyncExternalStore`).

## 30-second example

```tsx
// main.tsx — root constructed once, outside React
import { createRoot, defineController, signal } from '@olas/core'

const counter = defineController(() => {
  const count = signal(0)
  return { count, inc: () => count.update((n) => n + 1) }
})

const root = createRoot(counter, { deps: {} })

// app.tsx — React reads signals
import { OlasProvider, useRoot, use } from '@olas/react'
import { createRoot as createReactRoot } from 'react-dom/client'

function App() {
  const api = useRoot<typeof counter.__types.api>()
  const value = use(api.count)
  return <button onClick={api.inc}>{value}</button>
}

createReactRoot(document.getElementById('root')!).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)
```

## API

```ts
// Provider + root resolution
function OlasProvider(props: { root: Root<unknown>; children: ReactNode }): JSX.Element
function useRoot<Api = unknown>(): Api
function useController<Api>(root: Root<Api>): Api  // back-compat — takes root explicitly

// Signal subscription
function use<T>(signal: ReadSignal<T>): T

// Bundled multi-signal hooks (one re-render trigger for N signals)
function useQuery<T>(subscription: AsyncState<T>): { data, error, status, isLoading, isFetching, isStale, lastUpdatedAt, hasPendingMutations, refetch }
function useField<T>(field: Field<T>): { value, errors, isValid, isDirty, touched, isValidating, set, reset, markTouched, revalidate }

// Opt-in suspension wrappers
function KeepAlive(props: { controller: { suspend(): void; resume(): void }; children: ReactNode }): ReactElement
function useSuspendOnHidden(controller: { suspend(): void; resume(): void }): void
```

See spec §20.10 for the full type signatures.

## Why `useSyncExternalStore`

`useSyncExternalStore` is React 18's official external-store API. It guarantees no tearing under concurrent rendering and works correctly under StrictMode's double-mount. Olas signals are external state from React's perspective; the adapter just bridges the two.

The hook-internal pattern: every signal `.subscribe()` fires synchronously with the current value on subscribe. The adapter swallows that first fire (React already has the value from `getSnapshot`) and only translates *actual changes* into store-change notifications.

## Fakes for tests

`@olas/core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)` so a component test can be driven without building a real controller:

```tsx
import { fakeField, fakeAsyncState } from '@olas/core/testing'

const fake = {
  draft: fakeField('hello'),
  user: fakeAsyncState({ data: { id: '1', name: 'Alice' } }),
}

render(<UserCard profile={fake} />)
```

The fakes satisfy the real `Field<T>` / `AsyncState<T>` types so they pass `useField` / `useQuery` without casts.

## Further reading

- [`.wiki/modules/react.md`](../../.wiki/modules/react.md) — how each hook is implemented and why.
- [`.wiki/flows/use-root.md`](../../.wiki/flows/use-root.md) — end-to-end flow from `createRoot` to DOM.
- Spec §16 and §20.10 — UI adapter contract.
