---
name: browser-storage-handles-fail
description: Two browser storage handles fail after the page has them - reading `localStorage` throws in a sandboxed iframe, and the browser can close an IndexedDB connection - so neither can be read once and trusted.
type: pitfall
covers:
  - packages/persist/src/storage.ts:22-47
  - packages/persist/src/index.ts:196-257
  - packages/persist/src/index.ts:736-752
edges:
  - { type: related, target: ../modules/persist.md }
  - { type: related, target: node-localstorage-shadows-jsdom.md }
  - { type: tested-by, target: ../../packages/persist/tests/persist.test.ts }
  - { type: tested-by, target: ../../packages/persist/tests/coverage-indexeddb.test.ts }
last_verified: 2026-09-25
confidence: medium
---

# Storage handles fail after the page gets them

## `localStorage` throws when read

In a sandboxed iframe without `allow-same-origin`, and in a browser that blocks site data, `window.localStorage` is a getter that throws a SecurityError. `typeof localStorage === 'undefined'` does not guard it: `typeof` of a declared global still calls the getter.

`LOCAL_STORAGE.get` used `typeof` as its guard, so the throw reached `createPersisted`, whose `storage.get(key)` sat outside any `try`. The throw left the controller factory, and the whole controller failed to build.

Two fixes, one per layer:

- **The adapter** reads the global inside a `try` (`webStorage`, `packages/persist/src/storage.ts:28-34`). A storage that throws counts as missing, as on a server. The adapter has no `onError`, so the app is not told. Rethrowing from every call was the other option, and it would report `'write'` on every change.
- **`createPersisted`** catches a throwing `get` and treats it as a rejected one (`loadFailed`, `packages/persist/src/index.ts:736-752`): `onError('load')`, the source keeps its value, `ready` settles. A custom adapter can throw there too.

`@kontsedal/olas-mutation-queue`'s `getLeaseStorage` already had the `try`.

## An IndexedDB connection closes under the page

The browser can close a connection the page holds. WebKit does it when its IndexedDB server goes away ("connection lost"), and clearing site data does it everywhere. The spec sets the connection's close pending flag at once, and fires `close` on it a task later. From the flag on, `transaction()` throws `InvalidStateError`.

`indexedDbAdapter` cached the connection's promise and reset it only on `versionchange`, so every later call threw. The query-cache plugin holds its writes until a read lands, so it never wrote again for the rest of the session.

The adapter now drops the connection on `close`, and treats an `InvalidStateError` from `transaction()` on a cached connection as the same event, since `close` may not have arrived yet (`packages/persist/src/index.ts:196-257`). It opens a new connection and tries once more. A second `InvalidStateError` rejects, so a browser that closes every connection cannot loop the adapter.

## How to spot it

A module-level cache of a storage handle, or a `typeof` guard on a browser global. Test with a getter that throws, and with a fake IndexedDB whose connection can be closed by the fake, not only by the code under test.
