---
"@kontsedal/olas-persist": minor
---

`clearPersisted` now refuses to guess its scope.

Called with no prefix it deleted every key the adapter could enumerate. The default adapter is `localStorage`, which the whole origin shares, so a "log out" also took the analytics ids, the consent record and whatever a third-party script had stored. The call now throws unless it is given a non-empty `prefix` or an explicit `{ all: true }`.

The signature grew an options object — `clearPersisted(storage, { prefix, all, onError })` — and the positional `clearPersisted(storage, prefix, onError)` form still works. An adapter with no `keys()` used to return silently; it now reports through `onError` under the key `'<keys>'`, so a caller can tell "nothing to delete" from "cannot enumerate". The function had no tests at all and now has six.

**Migration.** `clearPersisted()` and `clearPersisted(adapter)` throw. Pass `{ prefix: 'my-app/' }` for the scope you meant, or `{ all: true }` to keep the old behavior.
