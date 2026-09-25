---
"@kontsedal/olas-core": patch
---

**One bad collection item no longer freezes `ctx.collection`, and a `lazyChild` handle follows disposal and loader failures.**

A `ctx.collection` item whose `propsOf`, `factory` or `keyOf` threw stopped the whole reconcile. A removed item was disposed but still listed, the items after the bad one were not built, and every later change stopped at the same item. The throw now reaches `onError` as `kind: 'construction'`, that item is skipped, and the rest lands. A kept key whose `factory` throws keeps its child. A key rebuilt for a new controller type keeps its `suspendItem(key)`: the new child is built suspended. After the owner disposes, `items` is empty and `has()` is `false`.

A `ctx.lazyChild` handle kept `status: 'ready'` and the dead `api` after `dispose()`, and stayed `'loading'` when disposed mid-load. A disposed handle now reads `'idle'` with no `api`. A loader that throws synchronously, or returns no promise, sets `status: 'error'`, reaches `onError`, and makes `load()` return a rejected promise instead of throwing.
