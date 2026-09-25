# @kontsedal/olas-realtime

Two primitives over a consumer-supplied `RealtimeService`: `createRealtimePatcher` for the "WebSocket event → cache write" pattern, and `createLiveStream` for tail-mode buffers (logs, metrics, presence) with capacity + coalesced flush. `createConnectionState` and `onReconnect` follow the transport's connection. SPEC §16.5.

The package ships **no default transport**. Apps wire their own (WebSocket, Pusher, Supabase Realtime, Ably, …) and pass it through `ctx.deps.realtime` after augmenting `AmbientDeps`.

## Install

```bash
pnpm add @kontsedal/olas-realtime @kontsedal/olas-core @preact/signals-core
```

## 30-second example

```ts
import { bindQuery, defineController, defineQuery } from '@kontsedal/olas-core'
import {
  createLiveStream,
  createRealtimePatcher,
  type RealtimeService,
} from '@kontsedal/olas-realtime'

// Augment AmbientDeps once in your app's top-level types.
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}

type Post = { id: string; title: string; likes: number }
type Comment = { id: string; text: string }

type FeedEvent =
  | { type: 'post-updated'; post: Post }
  | { type: 'comment-added'; postId: string; comment: Comment }

const postQuery = defineQuery({
  id: 'post',
  key: (id: string) => ['post', id],
  fetcher: async ({ signal }, id: string) =>
    (await fetch(`/api/posts/${id}`, { signal })).json() as Promise<Post>,
})
const commentsQuery = defineQuery({
  id: 'post/comments',
  key: (postId: string) => ['post', postId, 'comments'],
  fetcher: async ({ signal }, postId: string) =>
    (await fetch(`/api/posts/${postId}/comments`, { signal })).json() as Promise<Comment[]>,
})

const feed = defineController((ctx) => {
  // The `origin` tags these writes, so cross-tab leaves them alone: every tab
  // receives the same push from the server itself.
  const posts = bindQuery(ctx, postQuery, { origin: 'realtime' })
  const comments = bindQuery(ctx, commentsQuery, { origin: 'realtime' })

  // Dispatch realtime events to type-keyed handlers. Each handler receives
  // its own variant of `FeedEvent`, so `ev.post` and `ev.comment` need no check.
  createRealtimePatcher<FeedEvent>(ctx, 'feed', {
    'post-updated': (ev) => posts.replace(ev.post.id, ev.post),
    'comment-added': (ev) => comments.write(ev.postId, (list = []) => [...list, ev.comment]),
  })

  // Or buffer a live tail with backpressure.
  const logs = createLiveStream<string>(ctx, 'logs', {
    capacity: 1000,
    flushMs: 16,
  })

  return { logs }
})
```

A server push is data that is already true, so the handlers use the canonical writes. `replace` takes a whole record and supersedes a fetch in flight. `write` patches an entry. `setData` is the optimistic write for a mutation's `onMutate`: a push applied with it leaves a live snapshot behind on every call.

## API

```ts nocheck
function createRealtimePatcher<TEvent extends { type: string }>(
  ctx: Ctx<RealtimeDeps>,
  channel: string | ReadSignal<string>,
  handlers: PatcherHandlers<TEvent>,
): void

function createLiveStream<TEvent>(
  ctx: Ctx<RealtimeDeps>,
  channel: string | ReadSignal<string>,
  options?: {
    capacity?: number                              // default 1000
    flushMs?: number                               // default 16
    rafFlush?: boolean                             // default false
    onDrop?: (dropped: readonly TEvent[]) => void
  },
): LiveStream<TEvent>

function createConnectionState(ctx: Ctx<RealtimeDeps>): ReadSignal<ConnectionState>

function onReconnect(ctx: Ctx<RealtimeDeps>, fn: () => void): void

// Each key's handler receives that key's variant; '*' receives the union.
type PatcherHandlers<TEvent extends { type: string }> = {
  [K in TEvent['type']]?: (event: Extract<TEvent, { type: K }>) => void
} & { '*'?: (event: TEvent) => void }

type LiveStream<TEvent> = {
  events: ReadSignal<readonly TEvent[]>
  isPaused: ReadSignal<boolean>
  pause(): void
  resume(): void
  clear(): void
}

type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'unknown'
```

| Name | What |
|---|---|
| `createRealtimePatcher` | Subscribe; dispatch by `event.type`. Each handler receives its own variant of the union. A `'*'` handler also sees every event, after the specific one. Handlers run inside `untracked`. Auto-unsubscribes on dispose. |
| `createLiveStream` | Tail buffer. `capacity` caps memory (oldest drops, and `onDrop` receives them); `flushMs` coalesces bursts into one signal write; `flushMs <= 0` flushes synchronously. `rafFlush` coalesces on `requestAnimationFrame` instead, and falls back to `setTimeout(0)` where there is none. |
| `createConnectionState` | A `ReadSignal` of the transport's connection state. It is `'unknown'` for a transport without `onConnectionChange`. With one, it starts at `'connected'` until the first report, or at the latest report when another user already holds the subscription. A resume starts it the same way. |
| `onReconnect` | Call `fn` when the connection returns to `'connected'` from another state. It does not fire for the initial `'connected'`. A resume that moves the state back to `'connected'` counts too. Pair it with a query `invalidate` to refetch what a disconnect missed. |
| `RealtimeService` | The consumer-implemented contract — `subscribe(channel, handler) → { unsubscribe }`, plus an optional `onConnectionChange`. |

## `RealtimeService` contract

```ts nocheck
type RealtimeSubscription = { unsubscribe(): void }

type RealtimeService = {
  subscribe<TEvent = unknown>(
    channel: string,
    handler: (event: TEvent) => void,
  ): RealtimeSubscription
  onConnectionChange?(handler: (state: ConnectionState) => void): () => void
}
```

Most transports already match this shape (Pusher, Ably, Supabase, raw WebSocket wrappers). Adapt yours into a tiny `RealtimeService` object and inject via `RootOptions.deps`.

## Lifecycle notes

- Subscriptions live inside `ctx.effect(...)`. They are unsubscribed on controller dispose.
- `channel` is a name or a `ReadSignal<string>`. When the signal changes, the patcher and the stream unsubscribe from the old channel and subscribe to the new one. So a per-route room is ``computed(() => `room:${params.value.roomId}`)``. A stream also empties its buffer on the change, as `clear()` does, because the buffered events came from the old channel.
- Every `createConnectionState` and `onReconnect` on one `RealtimeService` shares one `onConnectionChange` subscription. The first one opens it, and the last one to dispose or suspend closes it. The transport is called as a method, so a class-based one keeps its `this`.
- `pause()` flips a tracked signal — the effect re-runs and the subscription is torn down. `resume()` restores it. Already-buffered events are **preserved** across a pause, but events that arrive **during** the pause are **lost** — the subscription is gone, so nothing is received (let alone buffered) until `resume()`. To recover a gap, pair with `onReconnect(...)` + a query `invalidate` (refetch authoritative state) rather than relying on the buffer.
- `clear()` empties both the visible buffer and the pending-flush queue without touching the subscription.

## What's NOT included

- Default transport. Bring your own.
- Multi-channel patcher sugar. Call `createRealtimePatcher` per channel.
- Backpressure beyond `capacity`, `flushMs` and `rafFlush` (e.g. sampling, downsampling, priority queues).

## Further reading

- [`../../.wiki/modules/realtime.md`](../../.wiki/modules/realtime.md)
- [SPEC §16.5](../../SPEC.md#165-canonical-patterns) (real-time → cache patches; tail-buffer pattern).
