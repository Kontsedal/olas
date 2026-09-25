---
"@kontsedal/olas-core": major
"@kontsedal/olas-react": major
"@kontsedal/olas-devtools": patch
---

**The React hooks, renamed and completed; the aliases are gone.**

**react.**
- `use(signal)` is renamed `useValue(signal)`. `use` shadowed React 19's `React.use`, which takes a promise or a context.
- `useMutation` returns `mutate` and `run`. `mutate(vars)` returns nothing and is the call for an event handler: a failure lands on `error`, `status` and `onError`, and never becomes an unhandled rejection. `run(vars)` returns the run's promise, and the caller owns the rejection. `mutateAsync` is removed. The result also carries `status`.
- An aborted run no longer fires `useMutation`'s `onError` or `onSettled`. That covers a superseded `latest-wins` run, `reset()` and dispose. The mutation's own hooks in core already skipped aborts.
- `useQuery` returns every `AsyncState` value, now including `isPaused`, plus `reset` and `cancel` beside `refetch`.
- `useField` adds `setAsInitial`. Its actions, and `useMutation`'s, keep their identity across renders.
- The result types are exported: `UseQueryResult`, `UseSuspenseQueryResult`, `UseFieldResult`, `UseFieldInputResult`, `UseMutationResult`, `UseMutationCallbacks` and `MutateFn`.
- `KeepAlive` is removed. Use `SuspendOnUnmount`, which it aliased.

**core.**
- `AsyncState.promise()` is removed. Use `firstValue()`, which it aliased.
- `AsyncState` gains `cancel()`, so a `LocalCache` can abort its in-flight fetch the way a query subscription could.
- `ctx.signal` and `ctx.computed` are removed. Import `signal` and `computed`, which they re-exported.
- `selection()` is renamed `createSelection()`, like the rest of the `create*` family.
- `UseOptions` is renamed `QuerySubscriptionOptions`.

`npx @kontsedal/olas-codemod 1.0` rewrites the `use` and `KeepAlive` imports and their references, `mutateAsync` → `run`, and every awaited `mutate(...)` → `run(...)`.
