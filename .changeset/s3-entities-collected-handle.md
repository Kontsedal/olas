---
"@kontsedal/olas-entities": patch
---

**A subscription holds its slot after the caller drops the handle.**

`const off = entities.signal(Item, 'p1').subscribe(fn)` keeps only the unsubscribe. Once the handle was garbage-collected, the store lost its subscription count, and `maxSlots` could evict p1 under the live subscriber, which then saw `undefined`. The store now holds a handle strongly while a `subscribe` on it is open, and lets it go when the last one closes.
