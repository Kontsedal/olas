# @kontsedal/olas-realtime

Two composables over a consumer-supplied `RealtimeService`: `useRealtimePatcher` for the "WebSocket event → `query.setData(...)` cache patch" pattern, and `defineLiveStream` for tail-mode buffers (logs, metrics, presence) with capacity + coalesced flush. SPEC §16.5.

The package ships **no default transport**. Apps wire their own (WebSocket, Pusher, Supabase Realtime, Ably, …) and pass it through `ctx.deps.realtime` after augmenting `AmbientDeps`.

## Install

```bash
pnpm add @kontsedal/olas-realtime @kontsedal/olas-core @preact/signals-core
```

## 30-second example

```ts
import { defineController } from '@kontsedal/olas-core'
import {
  defineLiveStream,
  type RealtimeService,
  useRealtimePatcher,
} from '@kontsedal/olas-realtime'

// Augment AmbientDeps once in your app's top-level types.
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}

type FeedEvent =
  | { type: 'like-added'; postId: string }
  | { type: 'comment-added'; postId: string; text: string }

const feed = defineController((ctx) => {
  // Dispatch realtime events to type-keyed handlers.
  useRealtimePatcher<FeedEvent>(ctx, 'feed', {
    'like-added': (ev) => topStories.setData(ev.postId, /* patch */),
    'comment-added': (ev) => comments.setData(ev.postId, /* patch */),
  })

  // Or buffer a live tail with backpressure.
  const logs = defineLiveStream<string>(ctx, 'logs', {
    capacity: 1000,
    flushMs: 16,
  })

  return { logs }
})
```

## API

```ts
function useRealtimePatcher<TEvent extends { type: string }>(
  ctx: Ctx<RealtimeDeps>,
  channel: string,
  handlers: PatcherHandlers<TEvent>,
): void

function defineLiveStream<TEvent>(
  ctx: Ctx<RealtimeDeps>,
  channel: string,
  options?: { capacity?: number; flushMs?: number },
): LiveStream<TEvent>

type LiveStream<TEvent> = {
  events: ReadSignal<readonly TEvent[]>
  isPaused: ReadSignal<boolean>
  pause(): void
  resume(): void
  clear(): void
}
```

| Name | What |
|---|---|
| `useRealtimePatcher` | Subscribe; dispatch by `event.type`. Handlers run inside `untracked`. Auto-unsubscribes on dispose. |
| `defineLiveStream` | Tail buffer. `capacity` caps memory (oldest drops); `flushMs` coalesces bursts into one signal write; `flushMs <= 0` flushes synchronously. |
| `RealtimeService` | The consumer-implemented contract — `subscribe(channel, handler) → { unsubscribe }`. |

## `RealtimeService` contract

```ts
type RealtimeSubscription = { unsubscribe(): void }

type RealtimeService = {
  subscribe<TEvent = unknown>(
    channel: string,
    handler: (event: TEvent) => void,
  ): RealtimeSubscription
}
```

Most transports already match this shape (Pusher, Ably, Supabase, raw WebSocket wrappers). Adapt yours into a tiny `RealtimeService` object and inject via `RootOptions.deps`.

## Lifecycle notes

- Subscriptions live inside `ctx.effect(...)`. They are unsubscribed on controller dispose.
- `pause()` flips a tracked signal — the effect re-runs and the subscription is torn down. `resume()` restores it. The buffer is **preserved** across a pause; only the subscription is cycled.
- `clear()` empties both the visible buffer and the pending-flush queue without touching the subscription.

## What's NOT included

- Default transport. Bring your own.
- Multi-channel patcher sugar. Call `useRealtimePatcher` per channel.
- Backpressure beyond `capacity` + `flushMs` (e.g. sampling, downsampling, priority queues). Tracked in [`../../BACKLOG.md`](../../BACKLOG.md).

## Further reading

- [`../../.wiki/modules/realtime.md`](../../.wiki/modules/realtime.md)
- SPEC §16.5 (real-time → cache patches; tail-buffer pattern).
