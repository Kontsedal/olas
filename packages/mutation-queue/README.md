# @kontsedal/olas-mutation-queue

Durable, replay-safe queue for `@kontsedal/olas-core` mutations. When a `defineMutation({ persist: true })` run is in flight and the user reloads (or the browser crashes), the queue replays the run on the next page load instead of silently dropping it. SPEC §13.3.

This is the offline-first complement to optimistic UI: the optimistic write lives in the cache (`@kontsedal/olas-core` + optionally `@kontsedal/olas-persist`), and the *server-side* write that backs it survives the reload via this queue.

## Install

```bash
pnpm add @kontsedal/olas-mutation-queue @kontsedal/olas-core @kontsedal/olas-persist @preact/signals-core
```

`@kontsedal/olas-persist` is a peer dependency — it provides the `StorageAdapter` interface the queue writes to. The two adapters shipped there (`localStorageAdapter`, `indexedDbAdapter`) both work; pick by payload size.

## 60-second example

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
  create: ctx.mutation({
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

That's the whole moving picture. The plugin is a [`QueryClientPlugin`](../../SPEC.md): it observes the mutation runner's `onMutationEnqueue` / `onMutationSettle` events, persists each pending entry under `<keyPrefix>/<mutationId>/<runId>`, and replays survivors on `init`.

## API

```ts
function mutationQueuePlugin(options: MutationQueueOptions): QueryClientPlugin

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
  onWarn?: (message: string, cause?: unknown) => void
}
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
| `onWarn` | Soft conditions: variables not JSON-serializable, malformed entry on disk, adapter missing `keys()`. Default: `console.warn`. |

## How it works

```
defineMutation({ persist: true })  →  registers mutationId at module scope
                                  ↓
ctx.mutation({...mutation}).run()  →  runner emits onMutationEnqueue
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

On `init` (root construction): list every entry under `keyPrefix`, group by `mutationId`, sort each group by `seq` (monotonic; falls back to `enqueuedAt`), wait for `navigator.onLine`, then replay serially per group. Different `mutationId` buckets run in parallel.

### Invariants

- **`mutate` must not close over controller state.** On replay there is no controller — only the module-scope `defineMutation(...)`. Use module-scope dependencies (a shared `api` client) or pass everything you need through `variables`.
- **Variables must be JSON-serializable.** Functions, symbols, class instances throw at enqueue; the throw is reported via `onWarn` and the in-process run continues without durability.
- **Same-`mutationId` runs are serial across loads.** `order/create` followed by `order/cancel` for the same id always run in order. Use distinct `mutationId`s for orthogonal operations.
- **Idempotency is the consumer's responsibility.** The queue guarantees at-least-once-until-success delivery. Include an `idempotencyKey` in your variables and have the server dedupe by it.

### Online wait + abort on dispose

Replay blocks on `navigator.onLine === true` before any `mutate` call. Tabs that boot offline don't burn `maxAttempts` against unreachable endpoints — they wait for the `online` event. When the root disposes, every in-flight replay aborts (the controller's `AbortSignal` rejects with `AbortError`) and any pending backoff sleep short-circuits.

## Combining with `@kontsedal/olas-persist`

The two packages solve adjacent problems:

| | `@kontsedal/olas-persist` | `@kontsedal/olas-mutation-queue` |
|---|---|---|
| What lives durably | Selected signals / cache entries | Pending `persist: true` mutation runs |
| When it writes | Every signal change | Mutation enqueue/settle |
| When it reads | Synchronously on controller construction | Asynchronously on root `init` |
| Cross-tab | Via the `storage` event | Not synced cross-tab in v1 |

Use both together when optimistic state must outlive a reload AND the server-side write must replay: `usePersisted` persists the cache view; the queue persists the in-flight POST.

## Caveats (v1)

- **No cross-tab arbitration.** Two tabs replaying the same `mutationId` on parallel reloads will both POST. Server-side dedupe (`idempotencyKey`) is the authoritative gate.
- **Adapter must implement `keys()`.** The `StorageAdapter` contract from `@kontsedal/olas-persist` doesn't require it, so custom adapters need to add it explicitly or replay is disabled (with a one-shot warning).
- **`PROTOCOL_VERSION` is `1`.** A future bump without a `migrate` handler drops every queued entry. Wire `migrate` from day one if you ever expect to deploy a schema change.
- **Entries are JSON, not structured-clone.** `BigInt`, `Date`, and typed arrays don't survive round-trip — convert at the boundary or store as strings.

## Further reading

- [SPEC §13.3](../../SPEC.md) — `MutationEnqueueEvent` / `MutationSettleEvent` contract.
- [SPEC §13.2](../../SPEC.md) — `QueryClientPlugin` lifecycle.
- [`../../RECIPES.md`](../../RECIPES.md) — Persisted mutations recipe.
- [`../persist/README.md`](../persist/README.md) — `localStorageAdapter` / `indexedDbAdapter`.
