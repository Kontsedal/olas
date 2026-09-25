---
"@kontsedal/olas-core": patch
---

**A local cache ignores a key thunk that re-runs to an equal key.**

A `createCache` key effect fetched on every run. So `key: () => [user.value.id]` refetched and aborted the request in flight whenever `user` got a new object with the same id, whatever the `staleTime`. It now compares keys by the same hash `createQuery` uses and does nothing when the key is unchanged. A key the hash cannot encode, such as a class instance, compares element by element.
