---
"@kontsedal/olas-persist": patch
---

**`persistQueryCachePlugin` keeps other tabs' entries, and `createPersisted` survives storage that fails or a value set to `undefined`.**

- `persistQueryCachePlugin` reads storage before every write and merges this session's entries into it. Each write used to put the tab's own map over the shared key, which deleted every entry another tab had stored since. When two tabs hold a copy of one entry, the one with the newer `lastUpdatedAt` is kept. A tab that restored an old copy no longer writes it over a peer's fresher fetch. With `restore: false` the plugin no longer reads storage at startup, since every write reads it.
- `createPersisted` round-trips `undefined`. It is stored as `{"$olas":1}`, or `{"$olas":1,"v":N}` with `version`, and a reload and another tab both read `undefined`. With `version` it used to read back as the object `{ $olas: 1, v: N }`. Without it the write failed as `'serialize'`, and a reload brought back the value the user had cleared.
- Another tab's delete puts back the value the source held before the load, which is what a reload shows. It used to set the source to `undefined`, whatever its type.
- A synchronous `storage.get` that throws reports `onError('load')`, as a rejected one does, and `ready` settles. It used to throw out of the controller factory.
- `localStorageAdapter` treats a `localStorage` that throws when read, as in a sandboxed iframe or with site data blocked, as missing.
- A `serialize` that returns no string reports `'serialize'` instead of storing a broken payload.
- `indexedDbAdapter` opens a new connection after the browser closes its connection, as WebKit does when its IndexedDB server goes away. An op that meets the closed connection before its `close` event retries once on a new one. Every later op used to fail with `InvalidStateError` for the rest of the session.
