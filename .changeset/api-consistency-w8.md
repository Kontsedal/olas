---
"@kontsedal/olas-core": major
"@kontsedal/olas-react": major
"@kontsedal/olas-zod": patch
---

**The last API consistency pass before 1.0.**

**core.**
- `createField(ctx, initial, options?)` takes an options bag, `{ validators, validateOn }`, like `createForm` and `createFieldArray`. `FieldOptions` is exported. `scripts/codemods/create-field.ts` rewrites the positional form.
- `ctx.session` is removed. Use `ctx.attach(def, props)`, which returns `{ api, dispose, suspend, resume }`.
- `root.suspend({ maxIdle })` is renamed `suspend({ maxIdleTime })`, and `SuspendOptions` is exported. Every duration is in milliseconds. Core's lifetime policies end in `Time` (`staleTime`, `gcTime`, `maxIdleTime`), and every other duration option ends in `Ms`.
- `AsyncState` gains `isEnabled`, `false` while a subscription's `enabled` returns `false`, and always `true` for a local cache.
- `refetch()` on a disabled subscription rejects with the new exported `QueryDisabledError`, which carries `queryId`. Before, it was an anonymous error you had to blanket-catch.
- `firstValue()` on a disabled subscription waits until the subscription is enabled and loaded, instead of rejecting at once. It rejects on dispose. While pending it returns the same promise.

**react.**
- `useRoot()` is typed through a `Register` interface the app augments once, so call sites drop the type argument:

  ```ts
  declare module '@kontsedal/olas-react' {
    interface Register { root: typeof root }
  }
  ```
- `useQuery` returns `isEnabled`.
- `useQuery(sub, { suspense: true })` on a disabled query suspends until the query is enabled and loads, which is what a dependent query needs. Development builds warn once when it starts. Before, it re-threw an already-rejected promise and never resolved.
- A `HydrationBoundary` whose `def` changes no longer re-hydrates the new root from the first root's server payload.
