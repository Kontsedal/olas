---
name: persist
description: "@kontsedal/olas-persist — createPersisted for one value, persistQueryCachePlugin for the query cache, the storage adapters."
type: module
covers:
  - packages/persist/src/index.ts
  - packages/persist/src/storage.ts
  - packages/persist/src/query-cache.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/persist/tests/persist.test.ts }
  - { type: tested-by, target: ../../packages/persist/tests/indexeddb-adapter.test.ts }
  - { type: tested-by, target: ../../packages/persist/tests/query-cache.test.ts }
  - { type: tested-by, target: ../../packages/persist/tests/version-skew.test.ts }
  - { type: tested-by, target: ../../packages/persist/tests/first-delivery.test.ts }
  - { type: tested-by, target: ../../packages/persist/tests/coverage-persisted.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: controller.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-persist`

Two ways to persist, over one storage contract:

- **`createPersisted(ctx, key, source, options?)`** persists one signal-like value. Spec §13.4, §20.11.
- **`persistQueryCachePlugin(options?)`** persists the query cache: see "The query cache" below.

`StorageAdapter`, the `localStorageAdapter()` default and its `LOCAL_STORAGE` object live in `storage.ts`, so the plugin module can import them without a cycle through `index.ts`. `indexedDbAdapter()` stays in `index.ts`.

## API

```ts
createPersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,  // Signal<T> | Field<T> | anything with value+set+subscribe
  options?: {
    storage?: StorageAdapter
    serialize?: (value: T) => string
    deserialize?: (raw: string) => T
    crossTab?: boolean
    version?: number            // {$olas,v,d} envelope + forward migration
    migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<...>
    throttleMs?: number         // debounce writes; flushed on dispose
    onError?: (err, op: PersistErrorOp, key) => void
  },
): Persisted  // { ready: ReadSignal<boolean> }
```

Cleanup is registered via `ctx.onDispose`. `PersistErrorOp` = `'load' | 'deserialize' | 'serialize' | 'write' | 'migrate' | 'remoteChange'`.

## Versioning + migration

`version: N` wraps writes in `{"$olas":1,"v":N,"d":<serialized>}` (`encodeForStorage`, `packages/persist/src/index.ts:391-397`). `decode` (`index.ts:407-412`) turns a stored string into `[payload, fromVersion]`, and `applyLoaded` and `applyRemote` both start from it. A matching `v` deserializes directly. A mismatched `v` goes to `migrate(raw, fromVersion)`, and so does a legacy un-enveloped payload, which arrives as `fromVersion: undefined`. A versioned reader with no migrator deserializes a legacy raw payload as is. The migrator returns the upgraded `T`, re-persisted as an envelope under `needsRewrite`, or `undefined` to drop the entry and leave the source at its default. A throwing migrator routes `onError('migrate')`. Version mismatch with no migrator discards the stored value. Tested in `persist.test.ts` (T6.1f).

## Builds that disagree on `version` (1.0)

A tab left open across a deploy runs two builds on one key. Before 1.0, a reader with `version: undefined` handed a versioned envelope whole to `deserialize`, so an old tab put `{v: 2, d: '…'}` in its signal. The fix had two halves, because a reader without `version` cannot unwrap `{v, d}` safely: a user value can have that shape.

- **The marker.** 1.0 writes the envelope with a `$olas: 1` key. Every reader unwraps a marked envelope, the unversioned one included (`decode`).
- **The escape.** A reader without `version` writes raw, as before, unless `envelopeOf` says a reader could take the raw string for an envelope. Then it writes `{"$olas":1,"d":<serialized>}`, a marked envelope with no `v`, which reads back as the raw value with `fromVersion: undefined` (`encodeForStorage`).

`envelopeOf` (`index.ts:325-338`) is the one predicate both sides use, so they cannot disagree. It returns `[payload, version, marked]` for a marked `{d: string, v?: number}` or an unmarked `{d: string, v: number}`, and `undefined` otherwise. A string that does not start with `{` or does not contain `"d"` is raw without a parse. That keeps the escape check off most writes, and it is safe because the writer's check and the reader's are the same function.

Data stored before 1.0 reads as it did. The unmarked `{v, d}` is an envelope only to a reader with `version`. To a reader without one it stays whole, because it may be a user value that 0.8 stored raw. So the original skew remains for a pre-1.0 envelope read by a 1.0 tab without `version`, which needs an app that dropped `version` between builds. The other residue is a 0.8 raw value that happens to be a marked envelope, a `$olas: 1` key next to a string `d`, which a 1.0 reader now unwraps. A 0.8 reader with `version` accepts the marked envelope, since its check only asked for a numeric `v` and a string `d`.

Pinned by `tests/version-skew.test.ts`, which runs six lookalike values through writers and readers with and without `version`.

## Error routing (`onError`)

Every fallible op routes through `onError(err, op, key)`, and is swallowed without one. Storage `get` reports `'load'` and `set` reports `'write'`. Encode reports `'serialize'` and decode reports `'deserialize'`. A migrator throw reports `'migrate'`, and cross-tab payload corruption reports `'remoteChange'`. Encode and write are **separate** failure domains, so a synchronous `localStorage.setItem` quota throw is a `'write'` error rather than a `'serialize'` one. `flushWrite` splits the two try blocks; the old single try mislabeled it (T6.1).

## Subscribe gotcha — the synchronous first delivery

Signal-core's `source.subscribe(handler)` fires immediately with the current value AND on every change. If we wrote on the initial delivery, we'd persist the initial value before the user has touched anything — wrong. Mitigation: a `subscribing` flag is true only while `source.subscribe(...)` runs (`index.ts:657-672`), and the handler returns early while it is set. Every later call is a change, and is written.

Before 1.0 the handler skipped its first call, whenever it came. That assumed an immediately-emitting source. An event-emitter-like source, which calls back only on a change, lost its first real change instead. The trade: a source that delivers its current value later, after `subscribe()` returns, now has that delivery written, and with async storage it counts as a user write before ready. No first-party source does that. Pinned by `tests/first-delivery.test.ts`, with a signal and a change-only source.

## Async storage + ready-gate races (T6.1)

`StorageAdapter.get` may return a `Promise<string | null>`. Code path:

- If sync (localStorage): `applyLoaded(loaded)` runs immediately; `ready$` flips true synchronously.
- If async: `loaded.then(applyLoaded, ...)`; `ready$` stays false until it resolves.

The *initial default* is not persisted during the not-ready window, because it would clobber the stored value. The subscribe callback's `subscribing` check handles that very first emit. A real **user write** before the load settles is NOT dropped. The subscribe handler records it in `userWroteBeforeReady` along with the value, and `settleReady` makes it win over the stored value and flushes it. A cross-tab change that races the load is buffered in `pendingRemoteRaw` and applied on ready, where a local user write outranks it. `applyLoaded` re-checks `userWroteBeforeReady` both before parsing and after any async migrate. Every `ready$.set(true)` in the load path goes through `settleReady` so the reconciliation runs on every exit. (Pre-fix: writes before ready were silently dropped, then `applyLoaded` overwrote the source — T6.1.)

## Cross-tab sync

`crossTab: true` requires `storage.onChange?(handler)`. The default `localStorageAdapter` uses the browser `storage` event; `indexedDbAdapter` layers `BroadcastChannel`. On a remote change, once ready, `applyRemote(rawValue)` (`index.ts:495-534`) reads the payload through `decode` with the load path's branch. A payload on this reader's `version` deserializes directly, and so does any payload for a reader without one. Another version, or a raw payload once `version` is set, goes to `migrate`, and is dropped without a migrator. `setFromRemote` (`index.ts:475-486`) then calls `source.set(value)` with `writingFromLoad` set, so the write is not echoed back. A null value is a cross-tab delete → mirrored as `undefined`. Corrupt payloads route `onError('remoteChange')`, and a throwing migrator `onError('migrate')`.

Two rules came out of the 1.0 review, each pinned in `coverage-persisted.test.ts`:

- **A peer's change drops a pending throttled write** (`dropPendingWrite`, `index.ts:448-453`, called from `setFromRemote`). Tab A with `throttleMs: 1000` set `'a'`; at 500 ms tab B wrote `'b'` and A showed it; at 1000 ms A flushed the stale `'a'`. Storage then held `'a'`, tab A `'b'` and tab B `'a'`, and nothing brought them back together. The peer's value is newer, so the waiting write goes. Pinned by "the pending write is dropped, so it cannot put the older value back" and "a cross-tab delete drops the pending write too".
- **The cross-tab path migrates as the load path does.** It used to deserialize a legacy unversioned payload from an old-build tab straight into a v2 signal. The signal got `{ theme: 'dark' }`, where the load path gave `{ theme: { mode: 'dark' } }`. A migrated peer value is not written back, because the old build still reads that key, and rewriting it would start a tug of war between builds. An async migrate applies only if no newer cross-tab change and no local write came since: `lastChange` counts both, and `settle` compares it. Pinned by the four tests under "createPersisted — cross-tab payloads that need migrating".

## Adapters

The package ships two `StorageAdapter` implementations:

- **`localStorageAdapter`** — sync `get`, `set` and `delete` via the browser `localStorage`. `onChange` listens to the `storage` event (fires only for writes in OTHER tabs — matches the platform). SSR-safe: no-ops when `localStorage` is undefined.
- **`indexedDbAdapter(options?)`** — async `get`, `set` or `delete` via IndexedDB. Single key/value object store; database, store or channel names are configurable. IDB has no native change event, so `onChange` is layered via `BroadcastChannel`. Every write through this adapter posts a `{ key, value }` message. Other adapter instances on the same channel, including those in other tabs, dispatch it to their `onChange` handlers. Like `BroadcastChannel`, the message does **not** echo back to the sender's tab. SSR-safe: when no `IDBFactory` is available and no override is passed, every method resolves to a no-op. The `indexedDB` option lets callers inject a custom IDB factory (used by tests; useful for non-browser runtimes that ship their own implementation).
  - **Commit-ack (T6.1):** `runRequest` resolves on the transaction's `oncomplete`, not the request's `onsuccess` — a write's `onsuccess` fires before the data is durably committed, so quota and disk failures only surface as `tx.onabort` at commit. `get`, `set` and `delete` **reject** on failure rather than swallowing it, so `createPersisted`'s `onError` fires. The cross-tab broadcast runs only after the commit lands. An `onversionchange` handler closes the connection and drops the cached promise, so a stale connection never blocks another tab's upgrade. The next op re-opens, and a failed re-open rejects rather than no-oping forever).

Both adapters share the same `StorageAdapter` shape, so `createPersisted` is agnostic. IndexedDB is the right pick for larger payloads (above ~5MB localStorage quota), payloads with characters that bloat string serialization, or anywhere async storage is acceptable.

## `clearPersisted` names its own scope (0.9 review)

`clearPersisted(storage?, options?)` deletes stored keys, and it refuses to guess how many. With no `prefix` it used to delete every key the adapter enumerated — and the default adapter is `localStorage`, shared by the whole origin, so a "log out" also took analytics ids and consent records the app never wrote. It now throws unless given a non-empty `prefix` or an explicit `{ all: true }` (`packages/persist/src/index.ts`). The positional `clearPersisted(storage, prefix, onError)` form still resolves. An adapter with no `keys()` reports through `onError` under the key `'<keys>'` instead of returning silently, so a caller can tell "nothing matched" from "cannot enumerate". Six tests in `persist.test.ts`; the function had none before.

## Persisted state and server rendering (0.9 review)

`createPersisted` reads its adapter during controller construction, and `localStorageAdapter.get` is synchronous. On a returning visitor the stored values are therefore in the signals BEFORE `hydrateRoot` runs, while the server built its HTML from the defaults — a hydration mismatch, which React answers by discarding the server's markup. The fix belongs in the renderer, not here: hold persisted values back for one client render. `examples/reader-ssr/src/App.tsx` does it with a `useHydrated` built on `useSyncExternalStore`'s server-snapshot argument, and both `packages/persist/README.md` and the example README carry the pattern.

## The query cache (`query-cache.ts`, 1.0)

`persistQueryCachePlugin` writes the canonical writes of opted-in queries to one storage key, and restores them when a root starts. An opted-in query has `meta: { persist: true }`; the package augments `QueryMeta` with it. `include` overrides the rule.

- **What is written.** `onWrite` keeps a map of the latest entry per `id` and key hash, and flushes the whole map as `{ v: 1, buster, entries }`, throttled (`throttleMs`, default 1000). A write whose source is `'optimistic'` or `'rollback'` is skipped: it is a guess. `onRemove` (gc) drops the entry. Dispose flushes a pending write. Infinite entries keep their `pageParams`.
- **The map starts from storage, with or without `restore`.** A flush writes the whole map, so an entry missing from it is deleted from storage. `setup` always reads the key, and `load` (`packages/persist/src/query-cache.ts:256-270`) seeds the map with every stored entry the filters keep; only with `restore` does it also hydrate. With asynchronous storage, `reading` holds any flush until the read settles (`query-cache.ts:221-224`), and `readSettled` releases it, after a failed read too.
- **Restore, synchronous storage.** `setup` reads the key and `host.queries.hydrate`s the entries. Setup runs before any controller binds, so every entry is buffered and there on the first read.
- **Restore, asynchronous storage.** The read lands after controllers may have bound entries and started fetching. The restore fills only keys `host.queries.keys(id)` does not list. A bound entry's fetch is newer than storage, and `applyHydration` would supersede it. The restore is `host.track`ed, so `waitForIdle` waits for it. An entry already in the plugin's map (a write that beat the restore) is not overwritten.
- **Filters.** A payload under another `buster`, or with `v !== 1`, is dropped whole. An entry older than `maxAgeMs` (default 24 hours) is dropped. An entry that is not `{ id: string, key: array, lastUpdatedAt: number, pageParams?: array }` is dropped. A parse failure reports through `onError(err, 'restore')`, and the app starts cold.
- **`restoreQueryCache(options)`** reads ahead of `createRoot`, for an app whose first render must see restored data from async storage. Pass the result as `RootOptions.hydrate`, and `restore: false` to the plugin.

### Why `restore: false` still reads storage (1.0 review)

Before the review, the map was seeded only by the plugin's own restore. On the documented path, `restoreQueryCache` into `hydrate` plus `restore: false`, core buffers the hydrated entries and emits a `'hydrate'` write only when a query binds one. `host.queries.dehydrate()` does not include that buffer, so the plugin had no other way to see it. Session 1 visited page A; session 2 visited only page B, and its first flush wrote B alone. A's entry was gone. Reading storage again at setup costs one read, and it keeps `buster`, `maxAgeMs` and the entry checks, since the seed goes through the same `parse`. Pinned in `query-cache.test.ts` under "restore: false keeps what this session never bound", for sync and async storage and for a write that beats the read.

## What's NOT included

- Encryption.
- Conflict resolution across tabs beyond last-delivery-wins (a local user write outranks a racing load/remote at startup, but steady-state concurrent writes in two tabs are last-writer-wins).

## Restoring untrusted storage (1.0)

- `persistQueryCachePlugin`'s `parse` drops an entry whose `lastUpdatedAt` is not finite or is more than five minutes ahead. A far-future timestamp passed `maxAgeMs` and stayed fresh for any `staleTime`.
- An async restore reports a parse or restore throw through `onError`, with `.then(ok).catch(onError)`, as the sync path always did.
- `createPersisted` catches a throw from `source.set` during load, reports it as `'deserialize'`, and still settles `ready`, so later writes persist.

Pinned by `tests/query-cache-security.test.ts` and `tests/persisted-security.test.ts`; see `decisions/trust-model.md`.
