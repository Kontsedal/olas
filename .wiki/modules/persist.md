---
name: persist
description: "@kontsedal/olas-persist — usePersisted composable, localStorage adapter, optional cross-tab sync."
type: module
covers:
  - packages/persist/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/persist/tests/persist.test.ts }
  - { type: tested-by, target: ../../packages/persist/tests/indexeddb-adapter.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: controller.md }
last_verified: 2026-07-25
confidence: high
---

# `@kontsedal/olas-persist`

Single composable: `usePersisted(ctx, key, source, options?)`. Plus the `localStorageAdapter` default. Spec §13, §20.11.

## API

```ts
usePersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,  // Signal<T> | Field<T> | anything with value+set+subscribe
  options?: {
    storage?: StorageAdapter
    serialize?: (value: T) => string
    deserialize?: (raw: string) => T
    crossTab?: boolean
    version?: number            // {v,d} envelope + forward migration
    migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<...>
    throttleMs?: number         // debounce writes; flushed on dispose
    onError?: (err, op: PersistErrorOp, key) => void
  },
): Persisted  // { ready: ReadSignal<boolean> }
```

Cleanup is registered via `ctx.onDispose`. `PersistErrorOp` = `'load' | 'deserialize' | 'serialize' | 'write' | 'migrate' | 'remoteChange'`.

## Versioning + migration

`version: N` wraps writes in `{"v":N,"d":<serialized>}` (`encodeForStorage`, `index.ts`). On load, `applyLoaded` reads both shapes: a matching `v` deserializes directly; a mismatched `v` (or a legacy un-enveloped payload → `fromVersion: undefined`) is handed to `migrate(raw, fromVersion)`. The migrator returns the upgraded `T` (re-persisted as an envelope, `needsRewrite`) or `undefined` to drop the entry (source keeps its default). A throwing migrator routes `onError('migrate')`. Version mismatch with no migrator discards the stored value. Tested in `persist.test.ts` (T6.1f).

## Error routing (`onError`)

Every fallible op routes through `onError(err, op, key)` (else swallowed): storage `get` → `'load'`, `set` → `'write'`, encode/decode → `'serialize'`/`'deserialize'`, migrator throw → `'migrate'`, cross-tab payload corruption → `'remoteChange'`. Encode and write are **separate** failure domains — a synchronous `localStorage.setItem` quota throw is a `'write'` error, not `'serialize'` (`flushWrite` splits the two try blocks; the old single try mislabeled it — T6.1).

## Subscribe gotcha — skip-first-delivery

Signal-core's `source.subscribe(handler)` fires immediately with the current value AND on every change. If we wrote on the initial delivery, we'd persist the initial value before the user has touched anything — wrong. Mitigation: `let skipFirstDelivery = true` in the subscribe callback. The first invocation is suppressed; from the second onward, we serialize and write. Documented inline at the `source.subscribe(...)` handler in `index.ts` and tested in `persist.test.ts`.

## Async storage + ready-gate races (T6.1)

`StorageAdapter.get` may return a `Promise<string | null>`. Code path:

- If sync (localStorage): `applyLoaded(loaded)` runs immediately; `ready$` flips true synchronously.
- If async: `loaded.then(applyLoaded, ...)`; `ready$` stays false until it resolves.

The *initial default* isn't persisted during the not-ready window (it would clobber the stored value — the subscribe callback's `skipFirstDelivery` handles the very first emit). But a real **user write** before the load settles is NOT dropped: the subscribe handler records it (`userWroteBeforeReady` + value), and `settleReady` makes it win over the stored value and flushes it. A cross-tab change that races the load is buffered (`pendingRemoteRaw`) and applied on ready (a local user write outranks it). `applyLoaded` re-checks `userWroteBeforeReady` both before parsing and after any async migrate. Every `ready$.set(true)` in the load path goes through `settleReady` so the reconciliation runs on every exit. (Pre-fix: writes before ready were silently dropped, then `applyLoaded` overwrote the source — T6.1.)

## Cross-tab sync

`crossTab: true` requires `storage.onChange?(handler)`. The default `localStorageAdapter` uses the browser `storage` event; `indexedDbAdapter` layers `BroadcastChannel`. On a remote change (once ready), `applyRemote(rawValue)` deserializes (honoring the version envelope; peers on a different `v` are ignored) and calls `source.set(value)` with `writingFromLoad` set so the write isn't echoed back. A null value is a cross-tab delete → mirrored as `undefined`. Corrupt payloads route `onError('remoteChange')`.

## Adapters

The package ships two `StorageAdapter` implementations:

- **`localStorageAdapter`** — sync `get` / `set` / `delete` via the browser `localStorage`. `onChange` listens to the `storage` event (fires only for writes in OTHER tabs — matches the platform). SSR-safe: no-ops when `localStorage` is undefined.
- **`indexedDbAdapter(options?)`** — async `get` / `set` / `delete` via IndexedDB. Single key/value object store; database / store / channel names are configurable. IDB has no native change event, so `onChange` is layered via `BroadcastChannel`: every write through this adapter posts a `{ key, value }` message; other adapter instances on the same channel (including in other tabs) dispatch it to their `onChange` handlers. Like `BroadcastChannel`, the message does **not** echo back to the sender's tab. SSR-safe: when no `IDBFactory` is available and no override is passed, every method resolves to a no-op. The `indexedDB` option lets callers inject a custom IDB factory (used by tests; useful for non-browser runtimes that ship their own implementation).
  - **Commit-ack (T6.1):** `runRequest` resolves on the transaction's `oncomplete`, not the request's `onsuccess` — a write's `onsuccess` fires before the data is durably committed, so quota / disk failures only surface as `tx.onabort` at commit. `get`/`set`/`delete` **reject** on failure (no longer swallow), so `usePersisted`'s `onError` fires; the cross-tab broadcast runs only after the commit lands. An `onversionchange` handler closes the connection and drops the cached promise so a stale connection never blocks another tab's upgrade (the next op re-opens; a failed re-open rejects rather than no-oping forever).

Both adapters share the same `StorageAdapter` shape, so `usePersisted` is agnostic. IndexedDB is the right pick for larger payloads (above ~5MB localStorage quota), payloads with characters that bloat string serialization, or anywhere async storage is acceptable.

## What's NOT included

- Encryption.
- Conflict resolution across tabs beyond last-delivery-wins (a local user write outranks a racing load/remote at startup, but steady-state concurrent writes in two tabs are last-writer-wins).
