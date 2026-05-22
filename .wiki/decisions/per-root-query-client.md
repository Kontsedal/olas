---
name: per-root-query-client
description: Each root has its own QueryClient. No singletons. Why.
type: decision
covers:
  - packages/core/src/query/client.ts
  - packages/core/src/query/define.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: uses, target: ../entities/query-client.md }
last_verified: 2026-05-22
confidence: high
---

# Per-root QueryClient

## The choice

`createRoot(...)` instantiates a fresh `QueryClient`. Queries (`defineQuery(...)`) are module-scoped values, but their cache entries live on per-root clients. There is no global `queryClient` singleton.

## Why

### Test isolation

Tests create a root, run, dispose. Without per-root clients, cache state would bleed between tests. Per-root clients give you a fresh cache for every test with zero ceremony — `createTestController(def, { deps, props })` is enough.

The mechanism: each `Query` carries `__clients: Set<QueryClient>`. When a client binds an entry for a query, it adds itself to that set. `query.invalidate(...)` iterates the set and reaches every live client. On root dispose, the client removes itself from every touched query's `__clients`. After dispose + GC, the set is empty again.

### Multiple roots in one process

Sometimes useful: SSR + client hydration, web-worker controllers, micro-frontends, A/B variants. A singleton would force them to share cache state by accident.

### Deps and `onError` are per-root

A `QueryClient` carries the root's `onError`. Different roots can use different error handlers. A singleton would force one handler for all roots.

## The cost

Some duplicated cache when multiple roots are alive at once. In practice: rare, and the spec accepts this trade.

`query.prefetch(...)` is the one place where "which client?" is ambiguous when called outside a controller. Current behavior (`define.ts`): use the **first** client in `__clients`. For multi-root setups, that may be wrong. Spec §21.5 acknowledges this is implementation detail. If the multi-root prefetch case matters, the API needs to take a client explicitly.

## How the multi-root binding works mechanically

```ts
// define.ts
const query = {
  __olas: 'query',
  __spec: spec,
  __clients: new Set<QueryClient>(),

  invalidate(...args) {
    for (const client of this.__clients) client.invalidate(this, args)
  },
  invalidateAll() {
    for (const client of this.__clients) client.invalidateAll(this)
  },
  setData(...rest) {
    // collect rollbacks across clients; aggregate
  },
  prefetch(...args) {
    const [first] = this.__clients
    if (!first) return Promise.reject(...)
    return first.prefetch(this, args)
  },
}
```

```ts
// client.ts
bindEntry(query, args) {
  // ...
  query.__clients.add(this)
  this.touchedQueries.add(query)
  // ...
}
dispose() {
  for (const q of this.touchedQueries) q.__clients.delete(this)
  // ...
}
```
