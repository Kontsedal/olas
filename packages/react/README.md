# @kontsedal/olas-react

The React adapter for [Olas](../..). Tiny binding layer (~230 LOC) on top of `useSyncExternalStore`. The root is created **outside** React and resolved via context — so React never owns the controller lifetime, no double-construction under StrictMode, and concurrent rendering is safe by construction.

## Install

```bash
pnpm add @kontsedal/olas-react @kontsedal/olas-core @preact/signals-core react react-dom
```

`react >= 18` is a peer dep (we rely on `useSyncExternalStore`).

## 30-second example

```tsx
// counter.ts — controller defined outside React
import { defineController, signal, type ReadSignal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  return { count, inc: () => count.update((n) => n + 1) }
})

export type CounterApi = {
  count: ReadSignal<number>
  inc: () => void
}
```

```tsx
// main.tsx — root constructed once
import { createRoot } from '@kontsedal/olas-core'
import { createRoot as createReactRoot } from 'react-dom/client'
import { OlasProvider } from '@kontsedal/olas-react'
import { counter } from './counter'
import { App } from './App'

const root = createRoot(counter, { deps: {} })

createReactRoot(document.getElementById('root')!).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)
```

```tsx
// App.tsx — React reads signals via tiny hooks
import { use, useRoot } from '@kontsedal/olas-react'
import type { CounterApi } from './counter'

export function App() {
  const api = useRoot<CounterApi>()
  return <button onClick={api.inc}>{use(api.count)}</button>
}
```

## API

| Export | Purpose |
|---|---|
| `OlasProvider` | Pass the root through React context. |
| `useRoot<Api>()` | Resolve the provider's root api. Throws if no provider. |
| `useController<Api>(root)` | Back-compat — takes root explicitly (useful in tests). |
| `use(signal)` | Subscribe a component to one `ReadSignal<T>`. |
| `useQuery(state)` | Bundle all 8 signals on an `AsyncState<T>` into one render trigger. |
| `useField(field)` | Bundle all 5 signals on a `Field<T>` plus action methods. |
| `<KeepAlive>` | Suspend a child controller on unmount, resume on remount. |
| `useSuspendOnHidden(controller)` | Suspend when `document.visibilitychange` flips hidden. |

Full signatures and gotchas in [`../../API.md`](../../API.md#olasreact).

## Why `useSyncExternalStore`

`useSyncExternalStore` is React 18's official external-store API. It guarantees no tearing under concurrent rendering and works correctly under StrictMode's double-mount. Olas signals are external state from React's perspective; the adapter just bridges the two.

The internal pattern: every signal `.subscribe()` fires synchronously with the current value on subscribe. The adapter swallows that first fire (React already has the value from `getSnapshot`) and only translates *actual changes* into store-change notifications.

## Fakes for tests

`@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)` so a component test can be driven without building a real controller:

```tsx
import { fakeField, fakeAsyncState } from '@kontsedal/olas-core/testing'

const profile = {
  draft: fakeField('hello'),
  user: fakeAsyncState({ data: { id: '1', name: 'Alice' } }),
}

render(<UserCard profile={profile} />)
```

The fakes satisfy the real `Field<T>` / `AsyncState<T>` types so they pass `useField` / `useQuery` without casts.

## Further reading

- [`../../API.md`](../../API.md#olasreact) — every export, signature, example.
- [`../../.wiki/modules/react.md`](../../.wiki/modules/react.md) — how each hook is implemented and why.
- [`../../.wiki/flows/use-root.md`](../../.wiki/flows/use-root.md) — end-to-end flow from `createRoot` to DOM.
