---
"@kontsedal/olas-core": major
"@kontsedal/olas-react": patch
---

**Query defaults live on the engine, and one engine can serve many roots.**

```ts
createRoot(app, {
  deps,
  queries: queryEngine({ defaults: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } }),
  hydrate: window.__OLAS_STATE__,
  plugins: [crossTabPlugin({ channelName: 'app' })],
})
```

- **`queryEngine({ defaults })` is the one place for root-wide query defaults.** Before, focus refetch alone could be configured in five places, and `queryEngine`'s docstring disagreed with the code about which one won. The following are all removed:
  - `RootOptions.defaultQueryOptions`
  - the flat `RootOptions.refetchOnWindowFocus` / `refetchOnReconnect` shorthands
  - `QueryEngineOptions.defaultQueryOptions`, `plugins` and `hydrate`
- **`hydrate` and `plugins` belong to the root.** They are per-instance: a payload for this render, installations for this root.
- **An engine is a reusable definition.** It used to throw "already adopted" the second time a root took it. `HydrationBoundary` rebuilds its root from the same options under StrictMode and on a `def` change, so every StrictMode app that hydrated through it crashed. Each root now gets its own client from the same engine value, and it is safe to hoist one to module scope.
- `DefaultQueryOptions` is renamed `QueryDefaults`.
- `createTestController`'s `defaultQueryOptions` option is removed; pass `queries: queryEngine({ defaults })`.
