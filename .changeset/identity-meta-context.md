---
"@kontsedal/olas-core": major
"@kontsedal/olas-cross-tab": major
"@kontsedal/olas-mutation-queue": major
---

**Every shared query and every defined mutation is named by a required `id`. Plugin settings move to a typed `meta`. `mutate` and `createCache` fetchers receive `{ signal, deps }`.**

```ts
const userQuery = defineQuery({
  id: 'users/detail', // was the optional `queryId`
  key: (id: string) => [id],
  fetcher: ({ signal, deps }, id) => deps.api.getUser(id, { signal }),
  meta: { crossTab: true }, // was `crossTab: true`
})

const createOrder = defineMutation({
  id: 'order/create', // was `mutationId`
  mutate: (vars: OrderInput, { signal, deps }) => deps.api.createOrder(vars, { signal }),
  meta: { persist: true }, // was the implicit default
})

const place = createMutation(ctx, createOrder, { onSuccess: () => toast('Placed') })
```

- **`id` is required** on `defineQuery` and `defineInfiniteQuery`. An anonymous query was silently skipped by `dehydrate()`, by every plugin and by the devtools labels. Now every query is hydratable, pluggable and nameable. `defineMutation` requires `id` too. On an inline `createMutation` spec, `id` is optional and doubles as the devtools label, so `name` is gone.
- **`meta` carries plugin settings.** `QueryMeta` and `MutationMeta` are empty interfaces that each plugin package augments. Installing `@kontsedal/olas-cross-tab` adds `meta.crossTab`, and `@kontsedal/olas-mutation-queue` adds `meta.persist`. Core no longer knows either name. `crossTab: 'data'` is gone; use `true`.
- **`defineMutation` no longer persists by default.** Pass `meta: { persist: true }`. A definition describes only the write (`id`, `mutate`, `concurrency`, `retry`, `retryDelay`, `meta`). The owning controller adds lifecycle hooks with the new `createMutation(ctx, def, hooks)` overload, instead of spreading `{ ...def, onSuccess }`.
- **`mutate(vars, { signal, deps })`** replaces `mutate(vars, signal)`, and `createCache(ctx, ({ signal, deps }) => …)` replaces `(signal) => …`. Query fetchers already received this context. A replayed mutation reaches its services through `deps` rather than a module-level import.
- `ErrorContext.queryKey` becomes `queryId` + `key`. `MutationDisposedError.mutationName` becomes `mutationId`.
- New exported types: `QueryMeta`, `MutationMeta`, `MutateCtx`, `MutationDefinition`, `MutationHooks`, `MutationRun`, `FetchCtx`, `InfiniteFetchCtx`, `LocalCacheOptions`.
