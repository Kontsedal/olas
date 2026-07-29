---
"@kontsedal/olas-core": minor
---

`RootOptions.defaultQueryOptions` — root-wide query defaults.

App-wide query policy is now declared once at `createRoot` instead of restated on every `defineQuery`:

```ts
createRoot(app, { deps, defaultQueryOptions: { staleTime: 5 * 60_000, retry: 1 } })
```

Covers `staleTime`, `gcTime`, `retry`, `retryDelay`, `keepPreviousData`, `networkMode`, `structuralShare`, `refetchOnWindowFocus`, `refetchOnReconnect`. Resolution is `spec.X ?? defaultQueryOptions.X ?? built-in`, so a per-query spec field always wins. Applies to `defineQuery`, `defineInfiniteQuery`, and `ctx.cache` (`staleTime` / `keepPreviousData` — the fields `LocalCacheOptions` carries).

Why: the built-in defaults (`staleTime: 0`, `retry: 0`) are the right quiet choice per query, but an app wanting different ones had to repeat them N times, and a missed one presents as "why is this refetching on every subscribe?" rather than as an error. Especially relevant when porting a TanStack `QueryClient` config, whose defaults differ (`retry: 3`, `refetchOnWindowFocus: true`).

`refetchInterval` is deliberately **not** defaultable — a root-wide interval would start background polling for every query in the app. `refetchOnWindowFocus` / `refetchOnReconnect` are no-ops for infinite queries, which install no focus/reconnect subscription.

Additive and backward-compatible: omitting the option preserves today's behavior exactly. The pre-existing flat `RootOptions.refetchOnWindowFocus` / `refetchOnReconnect` keep working as shorthand; the `defaultQueryOptions` entry wins when both are set. `createTestController` accepts the option too, so controllers whose behavior depends on it are testable in isolation.
