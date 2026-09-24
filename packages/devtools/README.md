# @kontsedal/olas-devtools

In-app devtools UI for an Olas root, as two React components. `<DevtoolsLauncher>` is a floating draggable window with a launcher button. `<DevtoolsPanel>` is the panel itself, for embedding in your own chrome. Both read the same `root.debug` event stream.

## Install

```bash
pnpm add @kontsedal/olas-devtools @kontsedal/olas-core @kontsedal/olas-react @preact/signals-core react
```

`react >= 18`, `@kontsedal/olas-core` and `@kontsedal/olas-react` are peer deps, and core brings its own peer, `@preact/signals-core`.

## 30-second example

```tsx
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { DevtoolsLauncher } from '@kontsedal/olas-devtools'
import { OlasProvider } from '@kontsedal/olas-react'
import { App } from './App'
import { appController } from './app.controller'

const root = createRoot(appController, { deps: {}, queries: queryEngine() })

export function AppShell() {
  return (
    <OlasProvider root={root}>
      <App />
      {import.meta.env.DEV && <DevtoolsLauncher root={root} />}
    </OlasProvider>
  )
}
```

`import.meta.env.DEV` is Vite's development flag; use your bundler's equivalent. The package declares no side effects, so a production build where the flag is `false` drops the panel.

`DevtoolsLauncher` renders a small launcher button in the bottom right; clicking it opens a draggable, resizable window with the panel. Position + size + open and minimized state persist to `localStorage`.

If you'd rather host the panel yourself (e.g., fixed sidebar in a layout), import `DevtoolsPanel` directly and size it however you like. Styles are scoped to the `.olas-devtools-*` class prefix; no CSS imports needed.

## What you'll see

A search box sits above the tabs. Press `/` anywhere in the panel to focus it. It finds controllers, query ids, key args, mutations, form fields and payload content, groups the results by kind, and Enter jumps to the row and highlights it.

| Tab | Content |
|-----|---------|
| **Timeline** | The default. Every event, newest first, grouped by cause: a mutation run, its optimistic write and its rollback read as one collapsible chain. A cache write expands to a before-and-after diff. A plugin's `host.debug` events carry the plugin's name, and a chip per lane shows or hides them. |
| **Tree** | Live controller tree. Each node shows its path segment, lifecycle state and its `ctx.debug` variables, live. A disposed node stays for a while, greyed, with its variables frozen at dispose time. |
| **Cache** | Chronological log of cache events. |
| **Inspector** | Live state of every cache entry, refreshed on cache events. |
| **Mutations** | Chronological log of `mutation:run`, `success`, `error` and `rollback` events. |
| **Fields** | Field-level validation outcomes. |

Every long view mounts only the rows in view, so a 10,000-event timeline scrolls like a short one. The **Clear** button empties the event logs and the timeline. The tree and the inspector show live state rather than a log, so Clear keeps them.

## API

```ts nocheck
function DevtoolsLauncher(props: {
  root: Pick<Root<unknown>, 'debug'>
  defaultTab?: DevtoolsTab
  maxEntries?: number         // per-log cap, oldest drop first; default 100
  maxTimelineEntries?: number // timeline ring-buffer capacity; default 10,000
  urlHashKey?: string         // forwarded to the panel; persists tab + filters in the URL
  storageKey?: string         // localStorage key for window position/size; default 'olas-devtools-window'
  initial?: { x?: number; y?: number; w?: number; h?: number }
}): ReactElement

function DevtoolsPanel(props: {
  root: Pick<Root<unknown>, 'debug'>
  defaultTab?: DevtoolsTab
  maxEntries?: number
  maxTimelineEntries?: number
  urlHashKey?: string
}): ReactElement

type DevtoolsTab = 'timeline' | 'tree' | 'cache' | 'inspector' | 'mutations' | 'fields'

// Lower-level store — exported so consumers can build their own UI.
class DevtoolsStore {
  constructor(options?: DevtoolsStoreOptions) // maxEntries, maxTimelineEntries, maxDisposedNodes, coalesce, now

  readonly tree$: ReadSignal<ControllerNode>
  readonly cache$: ReadSignal<CacheEntry[]>
  readonly mutations$: ReadSignal<MutationEntry[]>
  readonly fields$: ReadSignal<FieldEntry[]>
  readonly events$: ReadSignal<TimelineEvent[]>   // the timeline's ring buffer
  readonly droppedEvents$: ReadSignal<number>     // events the ring overwrote
  readonly cacheState$: Signal<DebugCacheEntry[]> // live cache entries, for the inspector

  attach(root: Pick<Root<unknown>, 'debug'>): () => void // subscribes; returns unsubscribe
  handle(event: DebugEvent): void                        // for tests or programmatic feed
  pause(): void                                          // drop new events until resume()
  resume(): void
  clearLogs(): void
  search(query: string, limitPerKind?: number): SearchGroup[]
}
```

| Export | When to reach for it |
|---|---|
| `<DevtoolsLauncher root>` | The one-liner. Floating launcher button + a draggable, resizable panel window; position / size / open state persist to `localStorage`. |
| `<DevtoolsPanel root>` | The panel alone — embed it in your own chrome (a fixed sidebar, a split pane). |
| `DevtoolsStore` | The lower-level store behind the panel. `attach(root)` to subscribe, `handle(event)` to feed events, read `tree$`, `events$` and the log signals, or call `search` — build your own UI on top. |

## Important: what the panel keeps

The panel subscribes to `root.debug` on mount, and the bus replays the live controller tree to it, so the Tree is complete from the start. Cache, mutation and field events that fired before the mount are not replayed. Mount the panel early if you want them.

Memory stays bounded however long the session runs. The timeline keeps the newest `maxTimelineEntries` events, default 10,000, and its toolbar counts the ones it dropped. The cache, mutation and field logs keep `maxEntries` each, default 100. The tree drops the earliest-disposed subtrees beyond `maxDisposedNodes`, default 200, a `DevtoolsStore` option.

If you need historical state, build a parallel `DevtoolsStore` early (next to `createRoot`) and pass it into a custom UI later.

## What's emitted by the runtime

Spec §20.9 lists the full `DebugEvent` union. In development builds the runtime emits:

- **controller:** `constructed`, `suspended`, `resumed`, `disposed` and `debug`
- **cache:** `fetch-start`, `fetch-success`, `fetch-error`, `set-data`, `invalidated` and `gc`
- **snapshot:** `push`, `rollback` and `finalize`, for optimistic writes
- **mutation:** `run`, `success`, `error` and `rollback`
- **field:** `validated`
- **plugin:** `event`, for each `host.debug(payload)` a plugin makes

`cache:subscribed` is declared in the type, and the runtime does not emit it. The panel renders it when it arrives, and you can feed it through `store.handle(event)` from your own instrumentation.

## Further reading

- [`.wiki/modules/devtools.md`](../../.wiki/modules/devtools.md) — the event bus.
- [`.wiki/modules/devtools-panel.md`](../../.wiki/modules/devtools-panel.md) — the panel's internals.
- [SPEC §14](../../SPEC.md#14-devtools) for devtools, and [§20.9](../../SPEC.md#209-errors--devtools) for `DebugEvent`.
