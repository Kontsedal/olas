# @olas/devtools

In-app devtools panel for an Olas root. Drop in a React component, get a live view of the controller tree, cache events, mutation log, and field validations.

This is the in-app variant — a real browser-extension version (spec Phase 13's stretch goal) can be built later as a thin wrapper that pipes the same `root.__debug` events into a separate panel UI.

## Install

```bash
pnpm add @olas/devtools @olas/core @olas/react @preact/signals-core react
```

`react >= 18` and the three Olas packages are peer deps.

## 30-second example

```tsx
import { OlasProvider, useRoot } from '@olas/react'
import { DevtoolsPanel } from '@olas/devtools'
import { createRoot } from '@olas/core'

const root = createRoot(appController, { deps })

function AppShell() {
  return (
    <OlasProvider root={root}>
      <App />
      {import.meta.env.DEV && (
        <aside style={{ position: 'fixed', bottom: 0, right: 0, width: 480, height: 360 }}>
          <DevtoolsPanel root={root} />
        </aside>
      )}
    </OlasProvider>
  )
}
```

The panel is just a React component — wrap it in your own container and size it however you like. Inline styles are scoped to the `.olas-devtools-*` class prefix; no CSS imports are needed.

## What you'll see

| Tab | Content |
|-----|---------|
| **Tree** | Live controller tree. Each node shows its path segment and lifecycle state (active / suspended / disposed). |
| **Cache** | Chronological log of `cache:fetch-start` / `fetch-success` / `fetch-error` / `invalidated` / `gc` events. |
| **Mutations** | Chronological log of `mutation:run` / `success` / `error` / `rollback` events. |
| **Fields** | Field-level validation outcomes (when emitted — see below). |

The **Clear** button empties the three event logs (the tree is live state, not a log, and is preserved).

## API

```ts
function DevtoolsPanel(props: {
  root: Root<unknown>
  defaultTab?: 'tree' | 'cache' | 'mutations' | 'fields'
  maxEntries?: number    // per-log cap, oldest drop first; default 100
}): JSX.Element

// Lower-level store — exported so consumers can build their own UI.
class DevtoolsStore {
  readonly tree$: Signal<ControllerNode>
  readonly cache$: Signal<CacheEntry[]>
  readonly mutations$: Signal<MutationEntry[]>
  readonly fields$: Signal<FieldEntry[]>

  attach(root): () => void   // subscribes; returns unsubscribe
  handle(event): void        // for tests or programmatic feed
  clearLogs(): void
}
```

## Important: the panel sees only post-mount events

The panel subscribes to `root.__debug` on mount. Events that fired before mount (e.g. the root controller's `controller:constructed`) are NOT in the tree. Mount the panel as early as possible if you want the full picture. The cache / mutation / field logs are bounded by `maxEntries` (default 100) anyway.

If you need historical state, build a parallel `DevtoolsStore` early (next to `createRoot`) and pass it into a custom UI later.

## What's emitted by the runtime

Spec §20.9 lists the full `DebugEvent` union. Today the runtime emits:

- **controller:** `constructed` / `suspended` / `resumed` / `disposed`
- **cache:** `fetch-start` / `fetch-success` / `fetch-error` / `invalidated` / `gc`
- **mutation:** `run` / `success` / `error` / `rollback`

`cache:subscribed` and `field:validated` are declared in the type but not yet wired in the runtime. The panel renders them when they arrive; you can also feed them via `store.handle(event)` from your own instrumentation.

## Further reading

- [`.wiki/modules/devtools.md`](../../.wiki/modules/devtools.md) — internal mechanics.
- Spec §13 (Devtools), §20.9 (`DebugEvent`).
