---
"@kontsedal/olas-core": major
"@kontsedal/olas-entities": patch
---

**Brands are symbol keys, and `InfiniteQuery` gains `peek`, `write` and `replace`.**

**Brands.** Public values no longer carry `__olas`, `__t`, `__types`, `__id`, `__options` or `__create`. A value's kind, its phantom type slot and the engine's plumbing now live under symbol keys that core does not export. They stay out of autocomplete, `Object.keys` and `JSON.stringify`. This affects `ControllerDef`, `Query`, `InfiniteQuery`, `QueryEngine`, `Scope`, the `defineMutation` result, and entities' `EntityDef`.

The keys are `Symbol.for` symbols, so two copies of core in one bundle still recognize each other's values. Code that read `query.__olas` to tell a query from an infinite query should keep a reference to the definition instead.

`Scope` loses `__id`. A scope object is its own identity.

**`InfiniteQuery.peek`, `write` and `replace`** match `Query`'s:
- `peek(...args)` reads the loaded pages without creating an entry or subscribing.
- `write(...args, updater)` is a canonical patch. It pushes no snapshot and leaves an in-flight fetch alone.
- `replace(...args, pages)` takes whole pages and cancels the in-flight fetch.

The bound handles from `bindQuery` and `root.bindQuery` carry the same three methods.
