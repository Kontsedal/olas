# @kontsedal/olas-persist

Persist a `Signal<T>` or `Field<T>` (or anything with `.value` + `.set` + `.subscribe`) to `localStorage` — or any custom `StorageAdapter`. Optional cross-tab sync. Works with async storage backends.

## Install

```bash
pnpm add @kontsedal/olas-persist @kontsedal/olas-core @preact/signals-core
```

## 30-second example

```ts
import { defineController, signal } from '@kontsedal/olas-core'
import { usePersisted } from '@kontsedal/olas-persist'

const settings = defineController((ctx) => {
  const theme = signal<'light' | 'dark'>('light')

  // Reads from localStorage on construction, writes on every change.
  const persisted = usePersisted(ctx, 'app.theme', theme)

  return { theme, ready: persisted.ready }
})
```

`persisted.ready` flips to `true` once the initial load completes — synchronous for localStorage, useful for async storage adapters.

## API

```ts
function usePersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,
  options?: {
    storage?: StorageAdapter        // default: localStorageAdapter
    serialize?: (value: T) => string
    deserialize?: (raw: string) => T
    crossTab?: boolean              // wire window 'storage' event
  },
): { ready: ReadSignal<boolean> }
```

Defaults: `JSON.stringify` / `JSON.parse`. Override `serialize` / `deserialize` for custom shapes (Dates, Maps, etc.). Cleanup is registered via `ctx.onDispose`.

> **Note on serializer parity with `@kontsedal/olas-cross-tab`.** `@kontsedal/olas-persist` defaults to JSON; `@kontsedal/olas-cross-tab` uses structured clone via `BroadcastChannel`. They differ in what survives a round-trip: `Date` becomes a string under JSON but survives cross-tab; `Map`/`Set` are dropped by JSON but survive cross-tab; functions and symbols are dropped by both. If you use both packages on the same value, supply a `serialize` / `deserialize` pair to persist that matches cross-tab's structured-clone semantics.

> **Cross-tab delete.** When another tab calls `localStorage.removeItem(key)` (or your custom adapter signals `null` through `onChange`), the local source is reset to `undefined`. Consumers whose `T` excludes `undefined` should treat this as "value gone, fall back to your own initial".

Full signatures and types in [`../../API.md`](../../API.md#olaspersist).

## Custom storage adapter

The default `localStorageAdapter` is exported. Implement `StorageAdapter` for sessionStorage, IndexedDB, mobile native storage, etc.:

```ts
type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  delete(key: string): void | Promise<void>
  onChange?(handler: (key: string, value: string | null) => void): () => void
}
```

`get` returning a Promise is supported — `ready` stays `false` until the load completes. Writes during the "not yet ready" window are skipped so a stale storage value doesn't get clobbered by the source's initial-state default.

## Cross-tab sync

`{ crossTab: true }` wires the adapter's `onChange(...)` callback. The default localStorage adapter wires it to the browser's `storage` event. Updates from other tabs deserialize and call `source.set(value)` without echoing the write back.

## Further reading

- [`../../API.md`](../../API.md#olaspersist) — full reference.
- [`../../.wiki/modules/persist.md`](../../.wiki/modules/persist.md)
- SPEC §13 (Persistence), §20.11 (types).
- An IndexedDB adapter and schema-versioning helpers are tracked in [`../../BACKLOG.md`](../../BACKLOG.md).
