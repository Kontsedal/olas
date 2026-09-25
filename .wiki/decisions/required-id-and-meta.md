---
name: required-id-and-meta
description: Why every shared query and defined mutation needs a hand-written `id`, and why plugin settings live in a typed `meta` instead of core spec fields.
type: decision
covers:
  - packages/core/src/query/define.ts
  - packages/core/src/query/types.ts
  - packages/core/src/query/mutation.ts
  - packages/cross-tab/src/index.ts
  - packages/mutation-queue/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/cache-identity.test.ts }
  - { type: related, target: canonical-vs-optimistic-writes.md }
last_verified: 2026-09-25
confidence: medium
---

# A required `id`, and plugin settings in `meta`

## `id` is required

Before 1.0, `queryId` was optional. An anonymous query worked locally but was invisible everywhere a query has to be named across a boundary:
- `dehydrate()` skipped it with a warning;
- every plugin hook skipped it, since cross-tab and entities route by id;
- devtools could show only its key.

The failure was quiet. The page got slower (the client refetched), or a cross-tab sync simply did not happen. That silence was what made it worth changing.

Making `id` required removes the anonymous branch from every path that had one: dehydrate, the plugin emitters, and the hydration buffer key. It costs one string per query. The string has to be written by hand. `fetcher.name` and hashes of source text change under minification, and the id must match between the server and client bundles.

`defineMutation` requires `id` for the same reason: a replay after reload finds the definition by it. An inline `createMutation` spec may omit it, because nothing outside the controller needs to find that mutation. When given, it doubles as the devtools label, which is why `name` was dropped.

## Plugin settings live in `meta`

`QuerySpec.crossTab` and `MutationSpec.persist` were fields in core's own types for features core does not implement. Plugins read them back through `__spec` casts. A third plugin would have needed a third core field.

`QueryMeta` and `MutationMeta` are empty interfaces in core. A plugin package declares its own fields by module augmentation:

```ts
declare module '@kontsedal/olas-core' {
  interface QueryMeta { crossTab?: boolean }
}
```

`meta` is therefore typed by exactly the plugins an app installs, and core never reads it. The name follows TanStack Query's `meta`, which serves the same purpose.

## A definition is the write, not its lifecycle

`defineMutation` now takes only `id`, `mutate`, `concurrency`, `retry`, `retryDelay` and `meta`. Hooks go to `createMutation(ctx, def, hooks)`.

The old idiom `createMutation(ctx, { ...def, onSuccess })` had no answer for a definition that carried its own `onSuccess`, since the spread silently replaced it. On a replay there is no controller to run a hook against in any case. The brand on a definition is non-enumerable, so a spread still produces a plain inline spec rather than a mistyped definition.

## `mutate` and `createCache` get `{ signal, deps }`

Query fetchers already received `{ signal, deps }`, while `mutate` got a bare signal and the cache fetcher got only a signal. Three shapes for one idea is the inconsistency. The practical cost was that a replayed mutation had no way to reach the app's services except a module-level import, which the definition docs warned against. With `deps` in the context, the mutation queue replays with the root's `deps`.
