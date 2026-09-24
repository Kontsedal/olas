# @kontsedal/olas-mutation-queue

**Your user taps "Place order," the POST is in flight, and the tab reloads.** Without a durable queue, that mutation is gone. `@kontsedal/olas-mutation-queue` writes every run of a mutation defined with `meta: { persist: true }` to storage before its request goes out. It then replays that run on the next page load, or on **network reconnect** in the same session, instead of dropping it silently. Nothing persists unless its definition opts in.

It is the offline-first complement to optimistic UI. The optimistic write lives in the cache, in `@kontsedal/olas-core`. The *server-side* write that backs it survives the reload through this queue.

Delivery is **at-least-once-until-success** — pair it with a server-side idempotency key and you get an exactly-once *effect*. The honest limits behind "best-effort" are spelled out in [Caveats](#caveats), covering what a mid-crash or a second open tab can and cannot guarantee. None of them will surprise you if you have built a retry queue before.

## Install

```bash
pnpm add @kontsedal/olas-mutation-queue @kontsedal/olas-core @kontsedal/olas-persist @preact/signals-core
```

`@kontsedal/olas-persist` is a peer dependency — it provides the `StorageAdapter` interface the queue writes to. The two adapters shipped there (`localStorageAdapter()`, `indexedDbAdapter()`) both work; pick by payload size.

## 30-second example

<!-- snippet-prelude
declare function toast(message: string): void
-->
```ts
import {
  createMutation,
  createRoot,
  defineController,
  defineMutation,
  queryEngine,
} from '@kontsedal/olas-core'
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'

// 1. Declare a module-scope mutation, and opt it in to the queue. `id` is
//    required: a replay finds the definition by it.
export const createOrder = defineMutation({
  id: 'order/create',
  mutate: async (vars: { sku: string; idempotencyKey: string }, { signal }) => {
    const res = await fetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify(vars),
      signal,
    })
    if (!res.ok) throw new Error('create failed')
    return (await res.json()) as { id: string }
  },
  meta: { persist: true },
})

// 2. Use it from a controller exactly like any other mutation.
const checkout = defineController((ctx) => ({
  create: createMutation(ctx, createOrder, {
    onSuccess: () => toast('Order placed'),
  }),
}))

// 3. Install the plugin at the root.
const root = createRoot(checkout, {
  queries: queryEngine(),
  deps: {},
  plugins: [
    mutationQueuePlugin({
      storage: localStorageAdapter(),
      keyPrefix: 'my-app/mutations/v1',
    }),
  ],
})

root.api.create.run({ sku: 'A-1', idempotencyKey: crypto.randomUUID() })
// → written to storage before the request goes out
// → on success: entry deleted
// → on reload before success: entry replayed when the next root starts
```

That's the whole moving picture. The plugin is an Olas plugin (SPEC §13). Its `onMutation` hook records each run of an opted-in mutation. Its `wrapMutate` middleware writes the entry under `<keyPrefix>/<id>/<runId>` before the run's first attempt. When a root starts, the plugin replays the entries it finds.

## API

```ts nocheck
function mutationQueuePlugin(options: MutationQueueOptions): OlasPlugin

// The queue's service: ctx.inject(MutationQueue) in a controller,
// root.inject(MutationQueue) outside one.
const MutationQueue: Scope<MutationQueueService>
type MutationQueueService = { replayNow(): Promise<void> }

type MutationQueueOptions = {
  storage: StorageAdapter
  keyPrefix: string
  maxAttempts?: number          // default 5
  isRetryable?: (err: unknown, entry: QueueEntry) => boolean   // default: every failure retries
  ttlMs?: number                // default Infinity
  backoffMs?: number            // default 0
  maxBackoffMs?: number         // default 60_000
  maxEntryBytes?: number        // default 64 * 1024
  dedupeBy?: (mutationId: string, variables: unknown) => string | undefined
  migrate?: (raw: unknown, fromVersion: number) => QueueEntry | null
  onReplayError?: (err: unknown, entry: QueueEntry) => void
  onReplayAttempt?: (err: unknown, entry: QueueEntry) => void
  onReplaySettle?: (entry: QueueEntry, result: unknown, queries: QueryHost) => void
  onWarn?: (message: string, cause?: unknown) => void
}

type QueueEntry = {
  readonly v: 1
  readonly mutationId: string   // the definition's `id`
  readonly runId: string
  readonly variables: unknown
  readonly attempts: number
  readonly enqueuedAt: number
  readonly seq?: number
  readonly idempotencyKey?: string
}
```

| Option | What |
|---|---|
| `storage` | The durable store. `localStorageAdapter()` is the typical default; switch to `indexedDbAdapter()` when payloads are large or `localStorage`'s 5–10 MB quota is uncomfortably close. The adapter must implement `keys()` — both shipped adapters do. Custom adapters without `keys()` log a warning and skip replay. |
| `keyPrefix` | Required namespace prefix in storage. Use `'<app>/mutations/v<n>'`. Bump `v<n>` when you ship a schema change that can't be `migrate`-d. |
| `maxAttempts` | Maximum total replay attempts per entry across page loads (in-process retries inside one load are governed by the definition's `retry`). After exhaustion the entry is dropped and `onReplayError` fires. |
| `isRetryable` | Whether a failure is worth another attempt on a later load. Return `false` and the queue drops the entry at once and reports it through `onReplayError`, instead of spending every `maxAttempts` on it. The queue asks it about a live run's failure and a replay's. A throw is reported through `onWarn`, and the entry stays. See [Failures a retry cannot fix](#failures-a-retry-cannot-fix). |
| `ttlMs` | Drop entries older than `Date.now() - ttlMs` before any replay attempt. Useful for "if this hasn't gone through in a week, give up." Default is no TTL. |
| `backoffMs` / `maxBackoffMs` | Exponential backoff on cross-reload retries — `delay = min(backoffMs * 2^(attempts-1), maxBackoffMs)`. Default is no backoff (first retry runs immediately). |
| `maxEntryBytes` | Soft byte budget per JSON-serialized entry. Exceeding it calls `onWarn` and the write proceeds anyway. Default 64 KB. Set to `Infinity` to disable. |
| `dedupeBy` | Return a stable idempotency key from `(mutationId, variables)`. Two enqueues sharing the same key collapse — the second consumer promise still resolves but no second durable entry is written, and the collapsed run settles the entry it collapsed onto. The key also defines "the same logical operation" for the supersede rule, in place of the variables. Client-side cost reduction; the server must still dedupe authoritatively. |
| `migrate` | Translate entries written under a prior `PROTOCOL_VERSION` into the current shape. Return `null` to drop. Without a migrator, version mismatches silently discard the entry. |
| `onReplayError` | Fires when the queue gives up on an entry: `maxAttempts` exhausted, a failure `isRetryable` rejects, TTL expired, no module registered the `id`, or the definition is not `meta: { persist: true }`. The integration point for telemetry / "we couldn't deliver your action" UX. |
| `onReplayAttempt` | Fires on every non-terminal replay failure — surfaces "we'll retry later" indicators. |
| `onReplaySettle` | Fires after a queued mutation **replays successfully**, with `(entry, result, queries)`. `queries` is the root's `QueryHost`. A replay writes server truth outside any live query's knowledge, so invalidate the affected queries here. `queries.invalidate(id, key)` takes the query's `id` and the tuple its `key(...)` returns (`['user', id]`), not the call arguments. **Without it, UIs stay stale after a replay** until their own `staleTime` lapses. A throw is reported through `onWarn`. |
| `onWarn` | Soft conditions: variables not JSON-serializable, malformed entry on disk, adapter missing `keys()`. Default: `console.warn`. |

Reconciling after a replay:

```ts
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'

const queue = mutationQueuePlugin({
  storage: localStorageAdapter(),
  keyPrefix: 'my-app/mutations/v1',
  onReplaySettle: (entry, _result, queries) => {
    if (entry.mutationId === 'order/create') void queries.invalidate('orders/list', [])
  },
})
```

### Failures a retry cannot fix

By default the queue treats every failure as transient. A 422 fails the same way on every load, so it burns all `maxAttempts` before `onReplayError` fires, and with `backoffMs` set that takes several page loads. `isRetryable(err, entry)` tells the queue which failures to give up on at once.

`mutate` is your function, and it returns or throws whatever it likes, so the queue cannot read a status code on its own. Throw an error that carries the status, and read it in `isRetryable`:

<!-- snippet-prelude
declare function reportLostWrite(err: unknown, mutationId: string): void
-->
```ts
import { defineMutation } from '@kontsedal/olas-core'
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

export const createOrder = defineMutation({
  id: 'order/create',
  mutate: async (vars: { sku: string; idempotencyKey: string }, { signal }) => {
    const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify(vars), signal })
    if (!res.ok) throw new HttpError(res.status)
    return (await res.json()) as { id: string }
  },
  meta: { persist: true },
})

const queue = mutationQueuePlugin({
  storage: localStorageAdapter(),
  keyPrefix: 'my-app/mutations/v1',
  // A network error, a 5xx, a 408 or a 429 can pass on a later try.
  // Any other 4xx fails the same way on every load.
  isRetryable: (err) =>
    !(err instanceof HttpError) || err.status >= 500 || err.status === 408 || err.status === 429,
  onReplayError: (err, entry) => reportLostWrite(err, entry.mutationId),
})
```

A `false` drops the entry and calls `onReplayError(err, entry)` with the error `mutate` threw. The queue asks on the first failure of a live run too, so a 422 on the first request leaves nothing on disk for the next load. The last allowed attempt is final whatever `isRetryable` returns, and the queue does not ask about it. The definition's `retry` still governs retries inside one load. `isRetryable` decides only whether the entry waits for another load or reconnect.

## How it works

```
defineMutation({ id, meta: { persist: true } })  →  registers the id at module scope
                                  ↓
createMutation(ctx, def).run(vars)  →  onMutation 'start': record the entry
                                  ↓
            wrapMutate, attempt 0: write QueueEntry to <prefix>/<id>/<runId>
                                  ↓
                      await mutate(vars, { signal, deps })
                                  ↓
              ┌───────────── success ─────────────┐
              ↓                                   ↓
       onMutation 'success'            onMutation 'error' / 'cancel'
              ↓                                   ↓
       plugin: delete entry                plugin: keep entry (replay next load)
```

When the root starts, the plugin lists every entry under `keyPrefix` and checks each one (see [Stored entries](#stored-entries)). It groups them by `id`, sorts each group by the monotonic `seq` with a fallback to `enqueuedAt`, waits until the tab is online, then replays serially per group. Two tabs that open in the same millisecond can give unrelated entries the same `seq`, and `runId` breaks that tie. So every tab replays the same entries in the same order, whatever order its storage lists them in. Different `id` buckets run in parallel. A replay pass also runs on every reconnect, so an in-session failure retries on reconnect and not only on reload. `ctx.inject(MutationQueue).replayNow()` starts one by hand. All three paths funnel through one guarded runner, which prevents overlapping replays, wrapped in the cross-tab lock described below. After each successful replay, `onReplaySettle` fires so the app can invalidate affected queries.

Replays run through the engine's own mutation runner (`host.mutations.run`). The definition's `retry` and `concurrency` apply, `mutate` receives the root's `deps`, and the run appears in devtools. The startup pass counts toward `root.waitForIdle()` when the tab starts online. An offline start parks the pass until reconnect, and `waitForIdle` does not wait for that.

### Invariants

- **`mutate` must not close over controller state.** On replay there is no controller — only the module-scope `defineMutation(...)`. Reach services through the `deps` that `mutate` receives, which are the root's `deps` on a replay, or pass everything you need through `variables`. The hooks given to `createMutation` do not run on a replay, and `onReplaySettle` takes the place of `onSuccess` there.
- **Variables must be JSON-serializable.** A value JSON cannot encode, such as a `BigInt` or a cycle, fails the write. The failure is reported via `onWarn` and the in-process run continues without durability. JSON drops functions and symbols without an error.
- **Same-`id` runs are serial across loads.** `order/create` followed by `order/cancel` for the same id always run in order. Use distinct `id`s for orthogonal operations.
- **Idempotency is the consumer's responsibility.** The queue guarantees at-least-once-until-success delivery. Include an `idempotencyKey` in your variables and have the server dedupe by it.
- **One entry per logical operation, per tab.** A manual retry of a failed run supersedes the entry that run left behind, and a replay pass skips runs this tab is executing right now. Both rules are described in [Retries and the one-entry rule](#retries-and-the-one-entry-rule).

### Retries and the one-entry rule

A run that fails leaves its entry on disk, because the next page load should try it again. The user usually does not wait for that page load — they press the button again. That retry is a fresh run with a fresh `runId`, so its own success drops only its own entry, and the entry the first run left still describes an order the server has already taken. The next load replays it and the customer is charged twice.

The queue closes that window with three rules.

**A successful run supersedes the failed runs it retries.** When a run succeeds, the queue also drops the entries left by earlier runs of the same logical operation that settled in error. Identity is what `dedupeBy(mutationId, variables)` returns when you supply it, and the `id` plus the JSON form of the variables when you do not — a retry re-submits the same variables, while a new operation carries different ones. Only runs that have already settled are eligible, so a second submit that is still in flight keeps its own entry. A run that settled as `cancel` also keeps its entry: a reload mid-flight is indistinguishable from a cancel, and that entry is the whole reason the queue exists.

**A `dedupeBy` collapse settles the entry it collapsed onto.** The second enqueue under a live idempotency key writes no entry of its own. Its settle therefore acts on the owner's entry — dropping it on success, counting its attempts on error.

**A replay never touches a run this tab is executing.** A reconnect or a `replayNow()` that lands between a run's start and its settle sees that run's entry on disk and would fire the same request again. The queue skips those entries; the live run's own settle disposes of them. This guard is per-tab, so a second tab replaying during your in-flight run remains possible — see [Cross-tab replay coordination](#cross-tab-replay-coordination), and keep the server-side `idempotencyKey` gate.

### Stored entries

Storage is same-origin state that a user, an extension or an old build can write. The queue treats every entry as possibly corrupt, and checks it before a replay (SPEC §22):

- **Shape.** `v` is the current protocol version, `mutationId` and `runId` are non-empty strings, and `attempts` is a whole number of zero or more. `seq` is a finite number and `idempotencyKey` a string, when present.
- **Timestamps.** `enqueuedAt` is finite and at most five minutes in the future, for clock drift between tabs and loads. A far-future date would otherwise outlive any `ttlMs`.
- **Key.** The storage key must be the one the entry's own contents name, `<keyPrefix>/<mutationId>/<runId>`. Every later write and delete goes by that key, so a mismatched entry would stay on disk and replay on every load.
- **Opt-in.** The queue replays an entry only when the registered definition has `meta: { persist: true }`, looked up through `host.mutations.get`. An entry naming a registered mutation without that flag is deleted without running, and `onReplayError` reports it.

A malformed entry is deleted, and `onWarn` reports it. An entry `migrate` produced is checked the same way, then rewritten under the key its new contents name, so the migration runs once. Stored data can delay or repeat an opted-in write, but it cannot choose which operation runs.

### Online wait + abort on dispose

Replay blocks until the tab reports online (`navigator.onLine`) before any `mutate` call. Tabs that boot offline don't burn `maxAttempts` against unreachable endpoints — they wait for the reconnect. When the root disposes, the engine cancels every in-flight replay, the reconnect listener is removed, and any pending backoff sleep short-circuits. A replay cancelled that way is not a failed attempt: its bumped attempt count is already on disk, and the next load replays it. A pass parked on the offline wait is released too, so it hands back the cross-tab replay lock instead of holding it for a network that may never return.

### Cross-tab replay coordination

Two tabs replaying the same entries on parallel reloads would double-POST. The queue serializes replay across tabs with the **Web Locks API**, through `navigator.locks`. A tab that cannot get the lock skips the pass, and the holding tab replays every entry under the shared prefix, because they share storage. Where Web Locks is unavailable, as on older Safari, it falls back to a **best-effort, TTL'd `localStorage` lease**. In Node and SSR there is a single context, so it runs. This reduces — but, with the lease fallback, doesn't fully eliminate — duplicate replays, which is why server-side `idempotencyKey` dedupe remains the authoritative gate.

### The devtools lane

The queue publishes its replays through `host.debug`, onto its own lane in `@kontsedal/olas-devtools`. Like core, the package ships a development build behind the `development` export condition, and only that build has the lane code (SPEC §23). Each payload names its entry by `mutationId` and `runId`:

| `kind` | When | Other fields |
|---|---|---|
| `replay:attempt` | An attempt starts, after its bumped count is on disk | `attempt` |
| `replay:result` | The attempt settles | `attempt`, `result`, and `error` on a failure |
| `replay:skipped` | A pass leaves an entry without an attempt | `reason` |

`result` is `success`, `retry-later`, `max-attempts`, `not-retryable` or `aborted`. `reason` is `in-flight`, `not-registered`, `not-persisted`, `max-attempts` or `ttl-expired`. A payload carries ids and counts, and no variables. Its shape serves the panel, and a minor release can change it.

## Combining with `@kontsedal/olas-persist`

The two packages solve adjacent problems:

| | `@kontsedal/olas-persist` | `@kontsedal/olas-mutation-queue` |
|---|---|---|
| What lives durably | Selected signals (`createPersisted`) and the query cache (`persistQueryCachePlugin`) | Pending runs of `meta: { persist: true }` mutations |
| When it writes | Every signal change, and every canonical cache write (throttled) | Before a run's first attempt, and on settle |
| When it reads | On controller construction (`createPersisted`), and when the root starts (the cache plugin) | When the root starts |
| Cross-tab | Via the `storage` event | Replay coordinated cross-tab (Web Locks / best-effort lease) |

Use both together when state must outlive a reload AND the server-side write must replay: `createPersisted` keeps the view state, and the queue keeps the in-flight POST. `persistQueryCachePlugin` skips optimistic writes, because they are guesses. A pending run's optimistic cache state is therefore gone after the reload, until the replay lands and `onReplaySettle` invalidates the affected queries.

## Caveats

- **Cross-tab coordination is best-effort.** Web Locks (when available) gives an exclusive replay lock; the `localStorage`-lease fallback narrows but doesn't fully close the double-replay window. Server-side dedupe (`idempotencyKey`) is the authoritative gate.
- **Causal ordering holds only within an `id`.** Across different `id`s (and across tabs), replay order isn't guaranteed. If `order/cancel` must land after `order/create`, model them under one `id` or encode the dependency in your server.
- **A failed write costs durability, not the run.** `wrapMutate` awaits the storage write before the first `mutate` call, so the entry is on disk before the request goes out. A write that fails, such as on a full quota, is reported through `onWarn`, and the run proceeds without an entry.
- **Adapter must implement `keys()`.** The `StorageAdapter` contract from `@kontsedal/olas-persist` doesn't require it, so custom adapters need to add it explicitly or replay is disabled (with a warning on each pass).
- **Replay needs the definition's module.** An entry whose `id` no imported module registered stays on disk, and `onReplayError` reports it on each pass. Import every module that calls `defineMutation` with `meta: { persist: true }` before the root starts.
- **`PROTOCOL_VERSION` is `1`.** A future bump without a `migrate` handler drops every queued entry. Wire `migrate` from day one if you ever expect to deploy a schema change.
- **Entries are JSON, not structured-clone.** A `Date` comes back as a string, and a `Map`, a `Set` or a typed array does not survive the round-trip. Convert at the boundary or store as strings.

## Further reading

- [SPEC §20.8](../../SPEC.md#208-root--options) — `RootOptions.plugins`.
- SPEC §13 — the plugin host: `onMutation`, `wrapMutate` and `host.mutations`.
- SPEC §22 — the trust model for stored entries.
- [`../../RECIPES.md`](../../RECIPES.md) — Persisted mutations recipe.
- [`../persist/README.md`](../persist/README.md) — `localStorageAdapter()` and `indexedDbAdapter()`.
