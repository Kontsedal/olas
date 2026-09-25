---
name: per-root-query-client
description: Each root has its own QueryClient. No singletons. Why.
type: decision
covers:
  - packages/core/src/query/client.ts
  - packages/core/src/query/define.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/query-isolation.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: uses, target: ../entities/query-client.md }
last_verified: 2026-09-25
confidence: high
---

# Per-root QueryClient

Every root owns a QueryClient and its cache entries. Definitions are module-scoped, so roots can reuse a query while fetching with different deps.

## Selecting a root

As of 0.9, use `bindQuery(ctx, query)` or `root.bindQuery(query)` for imperative operations. The handle routes directly to its client (`packages/core/src/query/client.ts`, `bindQuery`; shared methods in `packages/core/src/query/actions.ts`). Binding does not fetch or subscribe. It registers the client so an unbound call can detect ambiguity. Bound prefetch works before subscriptions; retained handles fail after root disposal.

Unbound helpers remain single-root shortcuts. More than one registered root causes an error before any read, write, cancellation or fetch. Previously, writes/invalidation fanned out while reads/prefetch chose the first root. That behavior could cross SSR request boundaries even though storage was per root. The new guard and bound handles prevent the reproduced cross-root writes. An intentional broadcast must select each root explicitly. Cross-tab transport remains an opt-in plugin concern.

## Lifetime

A definition holds a Set of clients that have bound a handle or entry. The client tracks touched definitions and removes itself from their sets on disposal. One root's disposal does not invalidate another root's handle. Cache entries and deps remain root-local.

## Evidence

`packages/core/tests/query-isolation.test.ts` covers separate request data, optimistic rollback, canonical writes, cancellation, invalidation, prefetch, infinite queries, ambiguity guards and disposal. SPEC §21.5 defines the contract.
