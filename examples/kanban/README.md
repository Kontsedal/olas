# Flagship — kanban (React)

A project tracker that exercises essentially every primitive in the Olas
library through *natural* features, not contrived demos. The intent is that a
single feature open in the editor reads like a real app — and that the union
of all features doubles as a coverage map for the library.

## Feature → primitive map

| Visible feature | Library primitive |
|---|---|
| Multi-board sidebar with switching | `defineQuery({ crossTab: true })`, reactive key thunks |
| Active board grid | `defineQuery` + `ctx.use(query, () => [...])` |
| Drag-drop reorder *within* a column | `ctx.mutation({ concurrency: 'serial' })` |
| Drag-drop *across* columns | `ctx.mutation({ concurrency: 'parallel' })` with optimistic snapshot |
| Search bar (250 ms debounce → server) | `debounced()` + `ctx.mutation({ concurrency: 'latest-wins' })` |
| Filter chips (priority / label / assignee) | `computed()` composition over signals |
| Bulk move + multi-select | `selection<string>()` (handleClick range / meta) |
| Detail panel | `<KeepAlive controller={cardDetail}>` (suspend/resume on unmount) |
| Card detail form | `formFromZod` + `FieldArray` for subtasks |
| Async title-uniqueness check | `debouncedValidator()` |
| Assignee picker with shared user data | `entitiesPlugin` + `defineEntity<User>` |
| Label picker with shared label data | `entitiesPlugin` + `defineEntity<Label>` |
| Comments thread | `useLiveStream` over a BroadcastChannel realtime |
| "Another tab just moved a card" log | `useRealtimePatcher` |
| Two-tab cache convergence | `crossTabPlugin` |
| Persisted theme / density / sidebar / last-open board | `usePersisted` × N |
| Theme + density mirror to `<html>` | standalone `effect()` |
| Archived-cards drawer with paged scroll | `defineInfiniteQuery` |
| Background-tab polling pause | `useSuspendOnHidden(root)` |
| Notifications + global error toast | `ctx.emitter` + `ctx.on` + root `onError` (`ErrorContext`) |
| Activity feed | `ctx.emitter` + `ctx.on` |
| Per-feature scopes (board id, selected card, prefs) | `defineScope` + `ctx.provide` / `ctx.inject` |
| Devtools | `<DevtoolsLauncher root={...}>` |
| `AmbientDeps` augmentation | `declare module '@kontsedal/olas-core'` in `api/schema.ts` |

## Folder layout

Feature folders — each is a vertical slice you can open in isolation:

```
src/
├── main.tsx                 # mount + dispose hook
├── root.ts                  # createRoot + plugins + onError bridge
├── app.controller.ts        # top-level controller; mounts every feature
├── App.tsx                  # 3-pane shell (sidebar / main / detail)
├── styles.css               # imports tokens, motion, primitives, feature css
├── scopes.ts                # all scope definitions in one place
├── api/                     # fake api, broadcast realtime, schema (Zod + AmbientDeps)
├── entities/                # defineEntity<User>, defineEntity<Label>
├── features/
│   ├── boards/              # sidebar + switcher
│   ├── board/               # kanban grid + 3 mutation modes + drag/drop + selection
│   ├── card-detail/         # KeepAlive panel + form + async validator
│   ├── search/              # debounced search bar
│   ├── filters/             # chip picker (priority/label/assignee)
│   ├── comments/            # useLiveStream thread
│   ├── activity/            # emitter feed + remote-actor events
│   ├── notifications/       # ErrorContext-driven toasts
│   ├── archive/             # defineInfiniteQuery drawer
│   └── preferences/         # usePersisted theme/density/sidebar
└── ui/                      # kanban-local design system
    ├── tokens.css, motion.css, globals.css, primitives.css
    └── Button, Card, Input, Tag, Avatar, Toast, Dialog, …
```

## How realtime works

`@kontsedal/olas-realtime` expects a consumer-supplied `RealtimeService`.
The demo provides one backed by `BroadcastChannel` (`api/broadcast.ts`). Open
two browser windows and one acts as a remote actor:

1. **You move a card in window A.** The mutation's `onMutate` patches
   window A's cache optimistically and the `mutate` call resolves against
   window A's in-memory fake API.
2. `crossTabPlugin` replays the `setData` write to window B over a separate
   BroadcastChannel (`olas-kanban-cache`) → window B's UI updates without
   a refetch.
3. After success, the board controller `publish`es a `card.moved` event over
   the *realtime* channel (`olas-kanban-realtime`).
4. Window B's `useRealtimePatcher` picks it up, sees `event.by !== tabId`,
   and emits an "Another tab moved a card" entry into the activity scope —
   visible in the activity panel with a distinct accent.

The two channels are intentionally separate, mirroring real deployments where
the cache transport (e.g. a write-through CDN cache, an in-process pubsub)
is independent of the realtime fan-out (e.g. a WebSocket / Pusher / Supabase).

## Run it

```bash
pnpm install
pnpm --filter @kontsedal/olas-example-kanban dev        # http://localhost:5181
pnpm --filter @kontsedal/olas-example-kanban test
pnpm --filter @kontsedal/olas-example-kanban typecheck
pnpm --filter @kontsedal/olas-example-kanban build
```

## Read order

1. `src/api/types.ts` — domain shapes.
2. `src/app.controller.ts` — the *orchestrator*. Reads top-down like a wiring diagram.
3. `src/features/board/board.controller.ts` — three mutation modes side-by-side; this is where the testability claim lives.
4. `src/features/card-detail/card-detail.controller.ts` — `formFromZod` + `debouncedValidator` + KeepAlive shape.
5. `tests/board.test.ts` + `tests/cross-tab.test.ts` — see the mutations and the two-tab convergence verified deterministically.
