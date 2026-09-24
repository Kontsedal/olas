# @kontsedal/olas-persist

Two ways to keep state across reloads, over one storage contract:

- **`createPersisted`** persists one `Signal<T>` or `Field<T>` (or anything with `.value` + `.set` + `.subscribe`) to `localStorage` or any custom `StorageAdapter`. Cross-tab sync is optional, and async storage backends work.
- **`persistQueryCachePlugin`** persists the query cache, so a reload starts from the data the last session fetched.

## Install

```bash
pnpm add @kontsedal/olas-persist @kontsedal/olas-core @preact/signals-core
```

## 30-second example

```ts
import { defineController, signal } from '@kontsedal/olas-core'
import { createPersisted } from '@kontsedal/olas-persist'

const settings = defineController((ctx) => {
  const theme = signal<'light' | 'dark'>('light')

  // Reads from localStorage on construction, writes on every change.
  const persisted = createPersisted(ctx, 'app.theme', theme)

  return { theme, ready: persisted.ready }
})
```

`persisted.ready` flips to `true` once the initial load completes — synchronous for localStorage, useful for async storage adapters.

## API

```ts nocheck
function createPersisted<T>(
  ctx: Ctx,
  key: string,
  source: PersistableSource<T>,
  options?: {
    storage?: StorageAdapter        // default: localStorageAdapter()
    serialize?: (value: T) => string
    deserialize?: (raw: string) => T
    crossTab?: boolean              // wire the adapter's onChange
    version?: number                // enable the {v,d} envelope + migration
    migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<T | undefined>
    throttleMs?: number             // trailing write at most once per window (flushed on dispose). Default 0
    onError?: (err: unknown, op: PersistErrorOp, key: string) => void
  },
): { ready: ReadSignal<boolean> }

type PersistErrorOp = 'load' | 'deserialize' | 'serialize' | 'write' | 'migrate' | 'remoteChange'
```

Defaults: `JSON.stringify` and `JSON.parse`. Override `serialize` and `deserialize` for custom shapes (Dates, Maps, etc.). Cleanup is registered via `ctx.onDispose`. A `storage` of `undefined` falls back to `localStorageAdapter()`, so a controller can forward an optional `ctx.deps.storage` slot as it is.

**Schema versioning.** Set `version: N` to wrap writes in a `{"v":N,"d":<serialized>}` envelope. On load, a payload with a different `version` is handed to `migrate(raw, fromVersion)`, and so is a legacy un-versioned one, which arrives as `fromVersion: undefined`. The migrator returns the upgraded value, re-persisted as an envelope, or `undefined` to drop the entry.

**Error routing.** Every fallible op routes through `onError(err, op, key)` — storage `get`/`set` (quota, closed db, aborted IDB commit), `serialize`/`deserialize`, `migrate` throws, and cross-tab payload corruption. A stored value the source refuses (its `set` throws) is a `'deserialize'` error, and `ready` still settles, so later writes persist. Without `onError`, errors are swallowed. The IndexedDB adapter resolves writes on the transaction's **commit** (not the request's `onsuccess`), so a quota failure surfaces here rather than silently vanishing.

> **Note on serializer parity with `@kontsedal/olas-cross-tab`.** `@kontsedal/olas-persist` defaults to JSON; `@kontsedal/olas-cross-tab` uses structured clone via `BroadcastChannel`. They differ in what survives a round-trip. `Date` becomes a string under JSON but survives cross-tab. `Map` and `Set` are dropped by JSON but survive cross-tab. Functions and symbols survive neither: JSON drops them, and structured clone throws, so cross-tab drops that message. If you use both packages on the same value, supply a `serialize` and `deserialize` pair to persist that matches cross-tab's structured-clone semantics.

> **Cross-tab delete.** When another tab calls `localStorage.removeItem(key)` (or your custom adapter signals `null` through `onChange`), the local source is reset to `undefined`. Consumers whose `T` excludes `undefined` should treat this as "value gone, fall back to your own initial".

Full signatures and types in [`../../API.md`](../../API.md#kontsedalolas-persist).

## Custom storage adapter

Two adapters ship, both as factories: `localStorageAdapter()` and `indexedDbAdapter(options?)`. Implement `StorageAdapter` for sessionStorage, mobile native storage, etc.:

```ts nocheck
type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  delete(key: string): void | Promise<void>
  onChange?(handler: (key: string, value: string | null) => void): () => void
  keys?(): Iterable<string> | Promise<Iterable<string>>   // for clearPersisted and the mutation queue
}
```

`get` returning a Promise is supported — `ready` stays `false` until the load completes. The source's *initial default* is not persisted during that window, because it would clobber the stored value. A real **user write** before the load settles is not lost: it wins over the stored value and is flushed once ready. A cross-tab change that races the load is buffered and applied on ready.

`indexedDbAdapter()` resolves each op on the transaction's commit and rejects on abort. It installs an `onversionchange` handler so it never blocks another tab's upgrade. Write failures propagate to `onError('write')` instead of vanishing. IndexedDB has no change event, so the adapter posts each write on a `BroadcastChannel`, and `onChange` in other tabs listens there.

## Cross-tab sync

`{ crossTab: true }` wires the adapter's `onChange(...)` callback. `localStorageAdapter()` wires it to the browser's `storage` event. Updates from other tabs deserialize and call `source.set(value)` without echoing the write back.

## Clearing on log-out

`clearPersisted(storage?, options)` deletes stored keys, and the caller names the scope. Pass a non-empty `prefix`, or `{ all: true }` to delete every key the adapter enumerates:

```ts
import { clearPersisted, localStorageAdapter } from '@kontsedal/olas-persist'

await clearPersisted(localStorageAdapter(), {
  prefix: 'my-app/',
  onError: (err, key) => console.warn('could not delete', key, err),
})
```

With neither option it throws. The default adapter is `localStorage`, which the whole origin shares, so an unscoped clear would also take analytics ids and consent records the app never wrote. An adapter without `keys()` cannot be enumerated: the call reports under the key `'<keys>'` through `onError` and deletes nothing.

## Persisting the query cache

`persistQueryCachePlugin` writes the query cache to storage and restores it when a root starts. A query opts in with `meta: { persist: true }`, which the package adds to core's `QueryMeta` type:

```ts
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { persistQueryCachePlugin } from '@kontsedal/olas-persist'

type User = { id: string; name: string }

const meQuery = defineQuery({
  id: 'user/me',
  key: () => [],
  fetcher: async ({ signal }) => (await fetch('/api/me', { signal })).json() as Promise<User>,
  meta: { persist: true },
})

const app = defineController((ctx) => ({ me: createQuery(ctx, meQuery) }))

const root = createRoot(app, {
  deps: {},
  queries: queryEngine(),
  plugins: [persistQueryCachePlugin({ buster: 'v1' })],
})
```

The opt-in is deliberate, because a cache can hold data that must not outlive the session. `include(query)` replaces the rule when the app needs another one.

**What is written.** The plugin keeps the latest entry per query and key, and writes the whole set under one storage key (`'olas/query-cache'` by default). Writes are throttled to one per `throttleMs` (default 1000), and dispose flushes a pending write. It writes canonical data only: a fetch, `write`, `replace` or hydration. An optimistic `setData` and its rollback are guesses the server has not confirmed, so they are skipped. An entry the cache garbage-collects is dropped from storage too. Infinite queries keep their `pageParams`, so a restored list keeps paging.

**When it restores.** With synchronous storage (the default, localStorage) the restore runs during plugin setup, before any controller subscribes, so a restored entry is there on the first read. With asynchronous storage the restore lands later. It fills only entries nothing has subscribed to yet, because a subscriber's fetch is newer than anything storage holds, and `root.waitForIdle()` waits for it. When the first render must see the restored data, read it ahead of `createRoot` with `restoreQueryCache` and turn the plugin's own restore off:

```ts
import { createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import {
  indexedDbAdapter,
  persistQueryCachePlugin,
  restoreQueryCache,
} from '@kontsedal/olas-persist'

const app = defineController(() => ({}))

const storage = indexedDbAdapter()
const hydrate = await restoreQueryCache({ storage })
const root = createRoot(app, {
  deps: {},
  queries: queryEngine(),
  hydrate,
  plugins: [persistQueryCachePlugin({ storage, restore: false })],
})
```

| Option | Default | What |
|---|---|---|
| `storage` | `localStorageAdapter()` | Where the cache is kept. |
| `key` | `'olas/query-cache'` | The storage key the whole cache is written under. |
| `buster` | `''` | A version for the stored shape. A cache written under another `buster` is discarded at restore. Change it when a persisted query's data changes shape. |
| `maxAgeMs` | 24 hours | Entries whose data is older than this are not restored. |
| `throttleMs` | `1000` | At most one storage write per window, carrying the latest cache. |
| `include` | `meta.persist === true` | Which queries persist. |
| `restore` | `true` | Restore when the root starts. Pass `false` after `restoreQueryCache`. |
| `onError` | a warning in development | `(error, op)` for a failed read, parse or write. `op` is `'restore'` or `'write'`. |

**What a restore checks.** Storage is same-origin state that a user, an extension or an old build can write, so the plugin treats it as possibly corrupt (SPEC §22):

- A payload under another `buster` or format version is dropped whole.
- An entry that is not `{ id, key, lastUpdatedAt, pageParams? }` with the right types is dropped.
- An entry older than `maxAgeMs` is dropped.
- An entry whose `lastUpdatedAt` is more than five minutes in the future is dropped. A planted future date would otherwise stay fresh for any `staleTime`, so its data would not refetch.
- A parse failure reports through `onError(err, 'restore')` on sync and async storage alike, and the app starts cold.

The plugin does not check that restored `data` matches the query's type. `buster` is the tool for a shape change.

## Server rendering

`localStorageAdapter()` reads synchronously, and `createPersisted` reads it while the controller is constructed. On a returning visitor the persisted values are therefore in the signals before `hydrateRoot` runs, and the server — which has no localStorage — built its HTML from the defaults. Rendering a persisted value on the hydrating pass is a hydration mismatch, and React answers those by discarding the server's markup.

Hold persisted values back for one client render rather than changing what the controller does. `useSyncExternalStore(subscribeToNothing, () => true, () => false)` is `false` on the server and on the hydrating render, and `true` from the render after; gate the persisted values on it. The reader-ssr example does this in [`examples/reader-ssr/src/App.tsx`](../../examples/reader-ssr/src/App.tsx) and explains the trade in [its README](../../examples/reader-ssr/README.md#persisted-state-and-the-first-render).

## Further reading

- [`../../API.md`](../../API.md#kontsedalolas-persist) — full reference.
- [`../../.wiki/modules/persist.md`](../../.wiki/modules/persist.md)
- SPEC §13.4 for persistence, §20.11 for the types, and §22 for the trust model.
