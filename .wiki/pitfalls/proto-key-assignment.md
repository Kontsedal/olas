---
name: proto-key-assignment
description: Rebuilding an object with `out[key] = value` swaps its prototype when the key is `__proto__` — which `JSON.parse` can put in a fetcher payload.
type: pitfall
covers:
  - packages/core/src/query/structural-share.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/structural-share.test.ts }
  - { type: uses, target: ../entities/entry.md }
last_verified: 2026-09-22
confidence: medium
---

# `out[key] = value` is wrong for one key

`structuralShare(prev, next)` rebuilds a changed plain object key by key. The obvious loop body is an assignment:

```ts
for (const key of Object.keys(next)) out[key] = walk(prev[key], next[key], seen)
```

That is correct for every key but one. `out` inherits from `Object.prototype`, which defines `__proto__` as an **accessor**. Assigning through it replaces `out`'s prototype and creates no property at all:

```ts
const out = {}
out.__proto__ = { inherited: true }
Object.keys(out)                              // []        — no property
Object.getPrototypeOf(out) === Object.prototype // false   — prototype swapped
out.inherited                                 // true      — now inherited
```

## Why a cache walker meets this

An own `__proto__` property is unusual but reachable, and `JSON.parse` is the one thing in a fetcher's path that produces one without anybody intending it:

```ts
const payload = JSON.parse('{"__proto__":{"inherited":true},"value":2}')
Object.keys(payload) // ['__proto__', 'value'] — an own, enumerable data property
```

Any API whose response echoes user-controlled keys can send that. Walked with a plain assignment, the shared result came back without the key and with a prototype the payload supplied. `inherited` then read `true` on a cached value the client hands to every subscriber.

`structural-share.ts` routes every key through `defineOwn`. That helper special-cases the one name with `Object.defineProperty`, writing the own, enumerable, writable, configurable property that assignment would have produced. Every other key is still a plain assignment, so the hot path is unchanged.

## The same trap in the reads

`walk`'s comparison side had the same trap twice over. `prev[key]` on a prev with no own `__proto__` returns *the prototype object*. `key in prev` is `true` for `__proto__` on any object inheriting from `Object.prototype`, so "prev does not have this key" answered false for the one key where it mattered. Both reads go through `Object.hasOwn(prev, key)` now.

## Related

`walk` admits two prototypes, `Object.prototype` and `null`, so the rebuilt object is created with the one both sides share. Rebuilding into a literal `{}` handed back a `Object.create(null)` payload wearing `Object.prototype`, and the `__proto__` accessor with it.

Anything else bails to the `next` ref before reaching the rebuild: `Map`, `Set`, `Date`, `RegExp`, a class instance. Plain objects and arrays are the whole surface.
