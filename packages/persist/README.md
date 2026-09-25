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
    version?: number                // enable the versioned envelope + migration
    migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<T | undefined>
    throttleMs?: number             // trailing write at most once per window (flushed on dispose). Default 0
    onError?: (err: unknown, op: PersistErrorOp, key: string) => void
  },
): { ready: ReadSignal<boolean> }

type PersistErrorOp = 'load' | 'deserialize' | 'serialize' | 'write' | 'migrate' | 'remoteChange'
```

Defaults: `JSON.stringify` and `JSON.parse`. Override `serialize` and `deserialize` for custom shapes (Dates, Maps, etc.). Cleanup is registered via `ctx.onDispose`. A `storage` of `undefined` falls back to `localStorageAdapter()`, so a controller can forward an optional `ctx.deps.storage` slot as it is.

**Custom sources.** A source's `subscribe` may call the handler at once with the current value, as a signal does, or only on a change, as an event emitter does. `createPersisted` skips a call made while `subscribe()` runs, because it is the current value and not a change. It writes every later call, so a source that does not call back on subscribe keeps its first change.

**Schema versioning.** Set `version: N` to wrap writes in the envelope `{"$olas":1,"v":N,"d":<serialized>}`. On load, a payload with an older `version` is handed to `migrate(raw, fromVersion)`, and so is a legacy un-versioned one, which arrives as `fromVersion: undefined`. The migrator returns the upgraded value, re-persisted as an envelope, or `undefined` to drop the entry. The re-persist is skipped when another tab's change arrived during the load, because storage holds that newer value. A payload with a newer `version` comes from a later build, and it does not reach the migrator. The source keeps its default, and storage keeps the payload for the build that wrote it. A cross-tab change goes through the same migrator, so a tab still running an old build cannot put an old-shaped value into this tab's signal.

**Builds that disagree on `version`.** A tab left open across a deploy runs the old build next to the new one, on the same key. A reader without `version` unwraps an envelope a newer build wrote, and deserializes the value inside it. The `$olas` marker keeps that safe: a value of yours with the same shape reads back as itself. Without `version`, `createPersisted` writes a value raw, and wraps it only when a reader could take it for an envelope. Data that versions before 1.0 stored reads as it did. Their envelope, `{"v":N,"d":…}`, has no marker, so a reader with `version` unwraps it, and a reader without one takes it as the value.

**Error routing.** Every fallible op routes through `onError(err, op, key)` — storage `get`/`set` (quota, closed db, aborted IDB commit), `serialize`/`deserialize`, `migrate` throws, and cross-tab payload corruption. A `get` that throws is a `'load'` error, as one that rejects is: the source keeps its value and `ready` settles. A stored value the source refuses (its `set` throws) is a `'deserialize'` error, and `ready` still settles, so later writes persist. A `serialize` that returns no string is a `'serialize'` error. Without `onError`, errors are swallowed. The IndexedDB adapter resolves writes on the transaction's **commit** (not the request's `onsuccess`), so a quota failure surfaces here rather than silently vanishing.

> **Note on serializer parity with `@kontsedal/olas-cross-tab`.** `@kontsedal/olas-persist` defaults to JSON; `@kontsedal/olas-cross-tab` uses structured clone via `BroadcastChannel`. They differ in what survives a round-trip. `Date` becomes a string under JSON but survives cross-tab. `Map` and `Set` are dropped by JSON but survive cross-tab. Functions and symbols survive neither: JSON drops them, and structured clone throws, so cross-tab drops that message. If you use both packages on the same value, supply a `serialize` and `deserialize` pair to persist that matches cross-tab's structured-clone semantics.

**`undefined` is a value.** Setting the source to `undefined` stores the marked envelope `{"$olas":1}`, or `{"$olas":1,"v":N}` with `version`, without calling `serialize`. A reload and a peer tab both read `undefined` back. A tab still on an older build of this package reads that envelope as the object `{ $olas: 1 }`.

> **Cross-tab delete.** When another tab calls `localStorage.removeItem(key)`, or your custom adapter signals `null` through `onChange`, the local source goes back to the value it held before the load. That is what a reload would show, since a reload of a missing key keeps the source's default.

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

`localStorageAdapter()` treats a `localStorage` that throws when the page reads it, as in a sandboxed iframe or with site data blocked, as missing: reads are `null` and writes do nothing.

`indexedDbAdapter()` resolves each op on the transaction's commit and rejects on abort. It installs an `onversionchange` handler so it never blocks another tab's upgrade. When the browser closes the connection itself, as WebKit does when its IndexedDB server goes away, the next op opens a new one. An op that meets the closed connection before its `close` event retries once on a new one. Write failures propagate to `onError('write')` instead of vanishing. IndexedDB has no change event, so the adapter posts each write on a `BroadcastChannel`, and `onChange` in other tabs listens there. It uses the global `BroadcastChannel` only in a browser tab or web worker. On a server (Node, Bun, Deno) a channel reaches every request in the process, so the adapter opens none there unless you pass `broadcastChannel`.

## Cross-tab sync

`{ crossTab: true }` wires the adapter's `onChange(...)` callback. `localStorageAdapter()` wires it to the browser's `storage` event. Updates from other tabs deserialize and call `source.set(value)` without echoing the write back.

- **Versions.** Another tab's value is read as a load is. With `version` set, a payload of an older version, or a raw one from a build before versioning, goes through `migrate`, and is dropped when there is no migrator. A payload of a newer version is dropped. The migrated value is not written back, because the tab that wrote it still reads that key.
- **Throttled writes.** With `throttleMs`, a write can still be waiting when another tab's change arrives. The other tab's value is newer, so the waiting write is dropped. Flushed later, it would put the older value back in storage, and the tabs would disagree from then on.

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

**What is written.** The plugin keeps the latest entry per query and key, and writes the whole set under one storage key (`'olas/query-cache'` by default). Every write reads what storage holds first and merges this session's entries into it, with or without `restore`. So a write keeps the entries this session never bound until they pass `maxAgeMs`. A read that fails holds the write: the next write reads storage again first. A session whose reads all fail writes nothing, because its write would delete the entries it could not read. A stored entry of a query that no longer passes `include` is dropped once the root uses that query. Writes are throttled to one per `throttleMs` (default 1000), and dispose flushes a pending write. It stores each entry's server truth, the data `dehydrate()` would ship: while an optimistic `setData` is live, the data beneath it. So a guess is never stored, even when a `write` made under it carries it, and a committed mutation is. A commit on an entry the server never answered for, such as an optimistic create, has no server time to age it by. It is not stored, and the next load fetches it. An entry the cache garbage-collects is dropped from storage too. Infinite queries keep their `pageParams`, so a restored list keeps paging.

**Several tabs.** Every tab of the app writes the same key, and the merge keeps what the other tabs wrote. When two tabs hold a copy of one entry, the copy with the newer `lastUpdatedAt` is kept. So a tab that restored an old copy never writes it over a peer's fresher fetch. An entry a tab garbage-collects leaves storage only when storage holds that tab's copy or an older one. The read and the write are two steps, not one transaction. Two tabs that write at the same moment can each miss the other's newest entry. The next write of the tab that lost it puts it back, because each write carries every entry its tab wrote. The plugin does not update one tab's in-memory cache from another's writes: `@kontsedal/olas-cross-tab` does that.

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
| `restore` | `true` | Restore when the root starts. Pass `false` after `restoreQueryCache`. The plugin still reads storage then, so its writes keep what it holds. |
| `onError` | a warning in development | `(error, op)` for a failed read, parse or write. `op` is `'restore'` or `'write'`; a failed read is `'restore'` even with `restore: false`. |

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
