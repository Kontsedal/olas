---
"@kontsedal/olas-entities": patch
---

**entities: a handle from `signal(entity, id)` survives `remove` and `maxSlots` eviction.**

`remove` and eviction used to delete the id's signal, so a view holding it stayed `undefined` after the entity came back, and a new `signal()` call returned a different object. The handle now reads whatever the store holds for the id: `undefined` while the entity is out, and the entity again once a query or `upsert` brings it back. It is the same object for as long as anything holds it. `maxSlots` no longer evicts an id a `subscribe` on its handle holds, so a mounted detail view keeps its entity after its query is collected. The handle is a read-only signal now, matching its `ReadSignal` type.
