# @kontsedal/olas-devtools

In-app devtools UI for an Olas root. Two React components: `<DevtoolsLauncher>` (floating draggable window with a launcher button) and `<DevtoolsPanel>` (the panel itself, for embedding in your own chrome). Both read the same `root.__debug` event stream.

A standalone browser extension reading the same stream is tracked in [`../../BACKLOG.md`](../../BACKLOG.md).

## Install

```bash
pnpm add @kontsedal/olas-devtools @kontsedal/olas-core @kontsedal/olas-react @preact/signals-core react
```

`react >= 18` and the three Olas packages are peer deps.

## 30-second example

```tsx
import { OlasProvider } from '@kontsedal/olas-react'
import { DevtoolsLauncher } from '@kontsedal/olas-devtools'
import { createRoot } from '@kontsedal/olas-core'

const root = createRoot(appController, { deps })

function AppShell() {
  return (
    <OlasProvider root={root}>
      <App />
      {import.meta.env.DEV && <DevtoolsLauncher root={root} />}
    </OlasProvider>
  )
}
```

`DevtoolsLauncher` renders a small launcher button in the bottom right; clicking it opens a draggable, resizable window with the panel. Position + size + open / minimized state persist to `localStorage`.

If you'd rather host the panel yourself (e.g., fixed sidebar in a layout), import `DevtoolsPanel` directly and size it however you like. Styles are scoped to the `.olas-devtools-*` class prefix; no CSS imports needed.

## What you'll see

| Tab | Content |
|-----|---------|
| **Tree** | Live controller tree. Each node shows its path segment and lifecycle state (active / suspended / disposed). |
| **Cache** | Chronological log of `cache:fetch-start` / `fetch-success` / `fetch-error` / `invalidated` / `gc` events. |
| **Mutations** | Chronological log of `mutation:run` / `success` / `error` / `rollback` events. |
| **Fields** | Field-level validation outcomes. **Inert today** — the runtime doesn't emit `field:validated` yet (see [What's emitted](#whats-emitted-by-the-runtime)); the tab fills in once it does, or when you feed events via `store.handle(...)`. |

The **Clear** button empties the three event logs (the tree is live state, not a log, and is preserved).

## API

```ts
function DevtoolsLauncher(props: {
  root: Pick<Root<unknown>, '__debug'>
  defaultTab?: DevtoolsTab
  maxEntries?: number       // per-log cap, oldest drop first; default 100
  urlHashKey?: string       // forwarded to the panel; persists open-tab in the URL
  storageKey?: string       // localStorage key for window position/size; default 'olas-devtools-window'
  initial?: { x?: number; y?: number; w?: number; h?: number }
}): JSX.Element

function DevtoolsPanel(props: {
  root: Pick<Root<unknown>, '__debug'>
  defaultTab?: DevtoolsTab
  maxEntries?: number
  urlHashKey?: string
}): JSX.Element

type DevtoolsTab = 'tree' | 'cache' | 'mutations' | 'fields' | 'events'

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

| Export | When to reach for it |
|---|---|
| `<DevtoolsLauncher root>` | The one-liner. Floating launcher button + a draggable, resizable panel window; position / size / open state persist to `localStorage`. |
| `<DevtoolsPanel root>` | The panel alone — embed it in your own chrome (a fixed sidebar, a split pane). |
| `DevtoolsStore` | The lower-level store behind the panel. `attach(root)` to subscribe, `handle(event)` to feed events, read `tree$` / `cache$` / `mutations$` / `fields$` — build your own UI on top. |

## Important: the panel sees only post-mount events

The panel subscribes to `root.__debug` on mount. Events that fired before mount (e.g. the root controller's `controller:constructed`) are NOT in the tree. Mount the panel as early as possible if you want the full picture. The cache / mutation / field logs are bounded by `maxEntries` (default 100) anyway, and the controller tree drops the oldest fully-disposed subtrees beyond `maxDisposedNodes` (default 200, a `DevtoolsStore` option) so a long, churny session stays bounded.

If you need historical state, build a parallel `DevtoolsStore` early (next to `createRoot`) and pass it into a custom UI later.

## What's emitted by the runtime

Spec §20.9 lists the full `DebugEvent` union. Today the runtime emits:

- **controller:** `constructed` / `suspended` / `resumed` / `disposed`
- **cache:** `fetch-start` / `fetch-success` / `fetch-error` / `invalidated` / `gc`
- **mutation:** `run` / `success` / `error` / `rollback`

`cache:subscribed` and `field:validated` are declared in the type but not yet wired in the runtime. The panel renders them when they arrive; you can also feed them via `store.handle(event)` from your own instrumentation.

## Further reading

- [`.wiki/modules/devtools.md`](../../.wiki/modules/devtools.md) — internal mechanics.
- [SPEC §14](../../SPEC.md#14-devtools) (Devtools), [§20.9](../../SPEC.md#209-errors--devtools) (`DebugEvent`).
