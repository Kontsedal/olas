# @olas/persist

Persist a `Signal<T>` or `Field<T>` (or anything with `.value` + `.set` + `.subscribe`) to `localStorage` — or any custom `StorageAdapter`. Optional cross-tab sync. Works with async storage backends.

## Install

```bash
pnpm add @olas/persist @olas/core @preact/signals-core
```

## 30-second example

```ts
import { defineController, signal } from '@olas/core'
import { usePersisted } from '@olas/persist'

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

Full signatures and types in [`../../API.md`](../../API.md#olaspersist).

## Custom storage adapter

The default `localStorageAdapter` is exported. Implement `StorageAdapter` for sessionStorage, IndexedDB, mobile native storage, etc.:

```ts
type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  remove(key: string): void | Promise<void>
  subscribe?(key: string, handler: (raw: string | null) => void): () => void
}
```

`get` returning a Promise is supported — `ready` stays `false` until the load completes. Writes during the "not yet ready" window are skipped so a stale storage value doesn't get clobbered by the source's initial-state default.

## Cross-tab sync

`{ crossTab: true }` wires the adapter's `subscribe(...)` callback. The default localStorage adapter wires it to the browser's `storage` event. Updates from other tabs deserialize and call `source.set(value)` without echoing the write back.

## Further reading

- [`../../API.md`](../../API.md#olaspersist) — full reference.
- [`../../.wiki/modules/persist.md`](../../.wiki/modules/persist.md)
- SPEC §13 (Persistence), §20.11 (types).
- An IndexedDB adapter and schema-versioning helpers are tracked in [`../../BACKLOG.md`](../../BACKLOG.md).
