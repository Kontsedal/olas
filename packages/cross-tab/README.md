# @kontsedal/olas-cross-tab

`BroadcastChannel`-backed cache sync for `@kontsedal/olas-core`. When one tab writes via `query.setData(...)` or `query.invalidate(...)`, every other tab of the same origin sees the same write — without re-fetching, without persistence, without a server round-trip. SPEC §13.2.

This is the **in-memory** sibling to `@kontsedal/olas-persist`. Persistence mirrors *durable* state on the `storage` event; this mirrors the (much larger) in-memory query cache that never touches disk. Both are independently opt-in.

## Install

```bash
pnpm add @kontsedal/olas-cross-tab @kontsedal/olas-core @preact/signals-core
```

## 30-second example

```ts
import { createRoot, defineController, defineQuery } from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'

// Opt the query in. `queryId` is required — it routes inbound messages
// across tabs without depending on the in-memory `Query` reference.
const userQuery = defineQuery({
  queryId: 'app/user/v1',
  crossTab: true,
  key: (id: string) => ['user', id],
  fetcher: (_ctx, id: string) => fetch(`/api/user/${id}`).then((r) => r.json()),
})

const appController = defineController((ctx) => {
  const user = ctx.use(userQuery, () => ['me' as string])
  return { user }
})

const root = createRoot(appController, {
  deps: {},
  plugins: [crossTabPlugin({ channelName: 'my-app/cache/v1' })],
})
```

Tab A calls `userQuery.setData('me', (prev) => ({ ...prev, name: 'New' }))` — Tab B's subscribers see the new value on the next signal flush. No fetch fires in Tab B.

## API

```ts
function crossTabPlugin(options: CrossTabOptions): QueryClientPlugin

type CrossTabOptions = {
  channelName: string
  onWarn?: (message: string, cause?: unknown) => void
  channelFactory?: (name: string) => ChannelLike | undefined
}
```

| Option | Default | What |
|---|---|---|
| `channelName` | required | Name of the `BroadcastChannel`. Include a version suffix (`my-app/v2`) for clean cross-deploy isolation — receivers from a different deploy with a different channel name simply don't see each other's traffic. |
| `onWarn` | `console.warn` | Called on non-fatal conditions: `DataCloneError` while broadcasting (the data isn't structured-cloneable) or a malformed inbound message. |
| `channelFactory` | `defaultChannelFactory` (wraps `BroadcastChannel`) | Override the channel constructor. Mainly for tests. Return `undefined` to disable cross-tab (the plugin becomes a no-op). |

## How it works

Every `setData` or `invalidate` on a `crossTab: true` query fires a `QueryClientPlugin` event (§13.2). This plugin posts the event onto a `BroadcastChannel`. Receiving tabs replay the write via the plugin api's `applyRemoteSetData` / `applyRemoteInvalidate` — both flagged `isRemote: true`, so the receiving tab's plugin doesn't echo back.

```
Tab A: query.setData(...) → QueryClient.setData → plugin.onSetData (isRemote: false)
                                                        ↓
                                                  channel.postMessage(msg)
                                                        ↓
                              ━━━━━━━━━━━━━━━━━━━ BroadcastChannel ━━━━━━━━━━━━━━━━━━━
                                                        ↓
Tab B: api.applyRemoteSetData(...) ← channel listener ← msg
       QueryClient.setData → plugin.onSetData (isRemote: true) → no rebroadcast
```

### Echo prevention (three layers)

1. **Sender-side:** the plugin skips outbound broadcasts when `SetDataEvent.isRemote === true` (the write was triggered by an inbound message).
2. **Own-source drop:** receivers filter messages by `sourceId` — every plugin instance picks a random one at construction. If the transport echoes the message back, the sender ignores it.
3. **`(sourceId, msgId)` dedup:** monotonic `msgId` per `sourceId` lets receivers drop out-of-order or duplicate messages.

### Protocol versioning

Messages carry `v: PROTOCOL_VERSION`. Receivers drop messages with a `v` they don't understand. Channel names themselves are user-supplied; for cross-deploy isolation, embed a version in your `channelName` (e.g. `'app/cache/v2'`).

### Non-cloneable data

`BroadcastChannel` uses structured clone. Cache data containing functions, class instances, or symbols throws `DataCloneError` at `postMessage`. The plugin catches the throw, calls `onWarn(...)`, and drops the message. **The sender's cache is unaffected** — only the cross-tab echo is lost.

## Per-query opt-in

Two fields on the spec gate cross-tab behavior:

- **`queryId: string`** — required. Stable name routed across tabs. Don't auto-derive from `fetcher.name` (fragile under minification) or argument hashing.
- **`crossTab: true`** — flips the per-query gate. Without it, the plugin doesn't broadcast (so module-internal queries don't leak).

Setting `crossTab: true` without a `queryId` logs a one-time `console.warn` (dev only) and disables sync for that query.

## SSR

When `BroadcastChannel === undefined` (Node, older browsers) and no `channelFactory` override is supplied, `crossTabPlugin(...)` returns a no-op plugin. The root still constructs cleanly; cross-tab is just disabled. This means you can wire the plugin unconditionally in shared code paths.

## Interaction with `@kontsedal/olas-persist`

These two layers solve different problems:

- `@kontsedal/olas-persist` mirrors **durable** state via `localStorage` + the `storage` event.
- `@kontsedal/olas-cross-tab` mirrors the **in-memory** query cache via `BroadcastChannel`.

You can combine them on the same logical entity, but it's redundant — `@kontsedal/olas-persist`'s cross-tab sync already covers the durable copy.

## Limitations (v1)

- **No infinite queries.** `defineInfiniteQuery` syncs are intentionally skipped — the page-array payload is too heavy to be a safe default. Plugin events fire with `kind: 'infinite'` for forward compatibility; this plugin filters them out.
- **No structural diffs.** Every `setData` broadcasts the full post-update value. For chunky cache entries this is fine because `BroadcastChannel` is in-memory; for very large arrays it's a known cost.
- **No pending-mutation arbitration.** If two tabs run optimistic mutations on the same entry concurrently, the last `setData` to arrive wins on both sides. Your mutation `onError` / `onSuccess` then re-syncs from the server, which restores convergence at the cost of a temporary divergence.
- **Optimistic writes cross tabs.** `setData` events fire regardless of cause, so optimistic state (and any rollback) is visible cross-tab. If you need optimistic UI to stay local, gate the write yourself.

## Further reading

- [`../../.wiki/modules/cross-tab.md`](../../.wiki/modules/cross-tab.md)
- SPEC §13.2 — Cross-tab in-memory cache sync.
- SPEC §5.2 — Query definition (`queryId`, `crossTab`).
- SPEC §20.8 — `RootOptions.plugins`.
