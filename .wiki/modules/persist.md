---
name: persist
description: "@kontsedal/olas-persist — usePersisted composable, localStorage adapter, optional cross-tab sync."
type: module
covers:
  - packages/persist/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/persist/tests/persist.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: controller.md }
last_verified: 2026-05-18
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
  },
): Persisted  // { ready: ReadSignal<boolean> }
```

Cleanup is registered via `ctx.onDispose`.

## Subscribe gotcha — skip-first-delivery

Signal-core's `source.subscribe(handler)` fires immediately with the current value AND on every change. If we wrote on the initial delivery, we'd persist the initial value before the user has touched anything — wrong. Mitigation: `let skipFirstDelivery = true` in the subscribe callback. The first invocation is suppressed; from the second onward, we serialize and write. This is documented inline in `index.ts:80-95` and tested in `persist.test.ts`.

## Async storage

`StorageAdapter.get` may return a `Promise<string | null>`. Code path:

- If sync (localStorage): `applyLoaded(loaded)` is called immediately. `ready$` flips true synchronously.
- If async: `loaded.then(applyLoaded, ...)`. `ready$` stays false until the promise resolves. Writes during the not-ready window are skipped (we don't want to clobber the loading row).

## Cross-tab sync

`crossTab: true` requires `storage.onChange?(handler)` to be defined. The default `localStorageAdapter` uses the browser `storage` event. On a remote change, deserialize and call `source.set(value)` (with `writingFromLoad` set so we don't echo the write back).

## What's NOT included

- IndexedDB adapter (deferred per spec §13).
- Schema versioning / migrations.
- Encryption.
