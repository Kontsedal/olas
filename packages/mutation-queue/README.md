# @kontsedal/olas-mutation-queue

**Your user taps "Place order," the POST is in flight, and the tab reloads.** Without a durable queue, that mutation is gone. `@kontsedal/olas-mutation-queue` writes every `defineMutation({ persist: true })` run to storage the moment it fires. It then replays that run on the next page load, or on **network reconnect** in the same session, instead of dropping it silently.

It is the offline-first complement to optimistic UI. The optimistic write lives in the cache, in `@kontsedal/olas-core` and optionally persisted via `@kontsedal/olas-persist`. The *server-side* write that backs it survives the reload through this queue.

Delivery is **at-least-once-until-success** — pair it with a server-side idempotency key and you get an exactly-once *effect*. The honest limits behind "best-effort" are spelled out in [Caveats](#caveats-v1), covering what a mid-crash or a second open tab can and cannot guarantee. None of them will surprise you if you have built a retry queue before.

## Install

```bash
pnpm add @kontsedal/olas-mutation-queue @kontsedal/olas-core @kontsedal/olas-persist @preact/signals-core
```

`@kontsedal/olas-persist` is a peer dependency — it provides the `StorageAdapter` interface the queue writes to. The two adapters shipped there (`localStorageAdapter`, `indexedDbAdapter`) both work; pick by payload size.

## 30-second example

```ts
import { createRoot, defineController, defineMutation } from '@kontsedal/olas-core'
import { localStorageAdapter } from '@kontsedal/olas-persist'
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'

// 1. Declare a module-scope persistable mutation. `mutationId` is required.
//    `defineMutation` defaults `persist: true`.
export const createOrder = defineMutation({
  mutationId: 'order/create',
  mutate: async (vars: { sku: string }, signal) => {
    const res = await fetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify(vars),
      signal,
    })
    if (!res.ok) throw new Error('create failed')
    return (await res.json()) as { id: string }
  },
})

// 2. Use it from a controller exactly like any other mutation.
const checkout = defineController((ctx) => ({
  create: createMutation(ctx, {
    ...createOrder,
    onSuccess: () => toast('Order placed'),
  }),
}))

// 3. Install the plugin at the root.
const root = createRoot(checkout, {
  deps: {},
  plugins: [
    mutationQueuePlugin({
      adapter: localStorageAdapter(),
      keyPrefix: 'my-app/mutations/v1',
    }),
  ],
})

root.create.run({ sku: 'A-1' })
// → enqueued to storage immediately
// → on success: entry deleted
// → on reload before success: entry replayed on next `init`
```

That's the whole moving picture. The plugin is a [`QueryClientPlugin`](../../SPEC.md#208-root--options): it observes the mutation runner's `onMutationEnqueue` and `onMutationSettle` events, persists each pending entry under `<keyPrefix>/<mutationId>/<runId>`, and replays survivors on `init`.

## API

```ts
// The returned plugin also exposes `replayNow(): Promise<void>` for manually
// re-driving the queue (in addition to init + the `online` reconnect trigger).
function mutationQueuePlugin(
  options: MutationQueueOptions,
): QueryClientPlugin & { replayNow(): Promise<void> }

type MutationQueueOptions = {
  adapter: StorageAdapter
  keyPrefix: string
  maxAttempts?: number          // default 5
  ttlMs?: number                // default Infinity
  backoffMs?: number            // default 0
  maxBackoffMs?: number         // default 60_000
  maxEntryBytes?: number        // default 64 * 1024
  dedupeBy?: (mutationId: string, variables: unknown) => string | undefined
  migrate?: (raw: unknown, fromVersion: number) => QueueEntry | null
  onReplayError?: (err: unknown, entry: QueueEntry) => void
  onReplayAttempt?: (err: unknown, entry: QueueEntry) => void
  onReplaySettle?: (entry: QueueEntry, result: unknown, api: ReplaySettleApi) => void
  onWarn?: (message: string, cause?: unknown) => void
}

// api.invalidate(query, callArgs) targets only the plugin's owning root
type ReplaySettleApi = { invalidate(query: Query<any, any>, callArgs?: readonly unknown[]): void }
```

| Option | What |
|---|---|
| `adapter` | The durable store. `localStorageAdapter()` is the typical default; switch to `indexedDbAdapter()` when payloads are large or `localStorage`'s 5–10 MB quota is uncomfortably close. The adapter must implement `keys()` — both shipped adapters do. Custom adapters without `keys()` log a warning and skip replay. |
| `keyPrefix` | Required namespace prefix in storage. Use `'<app>/mutations/v<n>'`. Bump `v<n>` when you ship a schema change that can't be `migrate`-d. |
| `maxAttempts` | Maximum total replay attempts per entry across page loads (in-process retries inside one load are governed by `spec.retry`). After exhaustion the entry is dropped and `onReplayError` fires. |
| `ttlMs` | Drop entries older than `Date.now() - ttlMs` before any replay attempt. Useful for "if this hasn't gone through in a week, give up." Default is no TTL. |
| `backoffMs` / `maxBackoffMs` | Exponential backoff on cross-reload retries — `delay = min(backoffMs * 2^(attempts-1), maxBackoffMs)`. Default is no backoff (first retry runs immediately). |
| `maxEntryBytes` | Soft byte budget per JSON-serialized entry. Exceeding it calls `onWarn` and the write proceeds anyway. Default 64 KB. Set to `Infinity` to disable. |
| `dedupeBy` | Return a stable idempotency key from `(mutationId, variables)`. Two enqueues sharing the same key collapse — the second consumer promise still resolves but no second durable entry is written. Client-side cost reduction; the server must still dedupe authoritatively. |
| `migrate` | Translate entries written under a prior `PROTOCOL_VERSION` into the current shape. Return `null` to drop. Without a migrator, version mismatches silently discard the entry. |
| `onReplayError` | Fires when replay gives up on an entry: `maxAttempts` exhausted, TTL expired, or no module registered the `mutationId`. The integration point for telemetry / "we couldn't deliver your action" UX. |
| `onReplayAttempt` | Fires on every non-terminal replay failure — surfaces "we'll retry later" indicators. |
| `onReplaySettle` | Fires after a queued mutation **replays successfully**, with `(entry, result, api)`. Invalidation targets only the plugin's owning root. A replay writes server truth outside any live query's knowledge — call `api.invalidate(query, callArgs)` here so subscribers refetch — `callArgs` are the query's own arguments (`[id]`), not the tuple `key()` returns (`['user', id]`). **Without it, UIs stay stale after a replay** until their own `staleTime` lapses. |
| `onWarn` | Soft conditions: variables not JSON-serializable, malformed entry on disk, adapter missing `keys()`. Default: `console.warn`. |

## How it works

```
defineMutation({ persist: true })  →  registers mutationId at module scope
                                  ↓
createMutation(ctx, {...mutation}).run()  →  runner emits onMutationEnqueue
                                  ↓
                              plugin: write QueueEntry to <prefix>/<id>/<runId>
                                  ↓
                              await mutate(variables, signal)
                                  ↓
              ┌───────────── success ─────────────┐
              ↓                                   ↓
       runner emits success                runner emits error / cancelled
              ↓                                   ↓
       plugin: delete entry                plugin: keep entry (replay next load)
```

On `init`, at root construction: list every entry under `keyPrefix`, group by `mutationId`, sort each group by the monotonic `seq` with a fallback to `enqueuedAt`, wait for `navigator.onLine`, then replay serially per group. Different `mutationId` buckets run in parallel. A replay pass also runs on every `online` event, so an in-session failure retries on reconnect and not only on reload, and on a manual `plugin.replayNow()`. All three paths funnel through one guarded runner, which prevents overlapping replays, wrapped in the cross-tab lock described below. After each successful replay, `onReplaySettle` fires so the app can invalidate affected queries.

### Invariants

- **`mutate` must not close over controller state.** On replay there is no controller — only the module-scope `defineMutation(...)`. Use module-scope dependencies (a shared `api` client) or pass everything you need through `variables`.
- **Variables must be JSON-serializable.** Functions, symbols, class instances throw at enqueue; the throw is reported via `onWarn` and the in-process run continues without durability.
- **Same-`mutationId` runs are serial across loads.** `order/create` followed by `order/cancel` for the same id always run in order. Use distinct `mutationId`s for orthogonal operations.
- **Idempotency is the consumer's responsibility.** The queue guarantees at-least-once-until-success delivery. Include an `idempotencyKey` in your variables and have the server dedupe by it.

### Online wait + abort on dispose

Replay blocks on `navigator.onLine === true` before any `mutate` call. Tabs that boot offline don't burn `maxAttempts` against unreachable endpoints — they wait for the `online` event. When the root disposes, every in-flight replay aborts (the controller's `AbortSignal` rejects with `AbortError`), the `online` listener is removed, and any pending backoff sleep short-circuits.

### Cross-tab replay coordination

Two tabs replaying the same entries on parallel reloads would double-POST. The queue serializes replay across tabs with the **Web Locks API**, through `navigator.locks`. A tab that cannot get the lock skips the pass, and the holding tab replays every entry under the shared prefix, because they share storage. Where Web Locks is unavailable, as on older Safari, it falls back to a **best-effort, TTL'd `localStorage` lease**. In Node and SSR there is a single context, so it runs. This reduces — but, with the lease fallback, doesn't fully eliminate — duplicate replays, which is why server-side `idempotencyKey` dedupe remains the authoritative gate.

## Combining with `@kontsedal/olas-persist`

The two packages solve adjacent problems:

| | `@kontsedal/olas-persist` | `@kontsedal/olas-mutation-queue` |
|---|---|---|
| What lives durably | Selected signals / cache entries | Pending `persist: true` mutation runs |
| When it writes | Every signal change | Mutation enqueue/settle |
| When it reads | Synchronously on controller construction | Asynchronously on root `init` |
| Cross-tab | Via the `storage` event | Replay coordinated cross-tab (Web Locks / best-effort lease) |

Use both together when optimistic state must outlive a reload AND the server-side write must replay: `usePersisted` persists the cache view; the queue persists the in-flight POST.

## Caveats (v1)

- **Cross-tab coordination is best-effort.** Web Locks (when available) gives an exclusive replay lock; the `localStorage`-lease fallback narrows but doesn't fully close the double-replay window. Server-side dedupe (`idempotencyKey`) is the authoritative gate.
- **Causal ordering holds only within a `mutationId`.** Across different `mutationId`s (and across tabs), replay order isn't guaranteed. If `order/cancel` must land after `order/create`, model them under one `mutationId` or encode the dependency in your server. (Tracked in `BACKLOG.md`.)
- **Enqueue is fire-and-forget.** `onMutationEnqueue` is a synchronous hook, so the durable write cannot be awaited. A crash in the sub-millisecond window before it commits loses that one entry, and `onWarn` reports the failure.
- **Adapter must implement `keys()`.** The `StorageAdapter` contract from `@kontsedal/olas-persist` doesn't require it, so custom adapters need to add it explicitly or replay is disabled (with a one-shot warning).
- **`PROTOCOL_VERSION` is `1`.** A future bump without a `migrate` handler drops every queued entry. Wire `migrate` from day one if you ever expect to deploy a schema change.
- **Entries are JSON, not structured-clone.** `BigInt`, `Date`, and typed arrays don't survive round-trip — convert at the boundary or store as strings.

## Further reading

- [SPEC §20.8](../../SPEC.md#208-root--options) — the `QueryClientPlugin` type this plugin implements.
- [SPEC §13.2](../../SPEC.md#132-cross-tab-in-memory-cache-sync) — the plugin event surface (`SetDataEvent`, `QueryClientPluginApi`).
- [`../../RECIPES.md`](../../RECIPES.md) — Persisted mutations recipe.
- [`../persist/README.md`](../persist/README.md) — `localStorageAdapter` and `indexedDbAdapter`.
