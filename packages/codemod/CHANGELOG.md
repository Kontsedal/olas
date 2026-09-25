# @kontsedal/olas-codemod

## 1.0.0

### Major Changes

- 892fead: **New: `@kontsedal/olas-codemod`, the 0.8 → 1.0 migration.**
  
  ```bash
  npx @kontsedal/olas-codemod 1.0 [--tsconfig <path>] [--dry] [paths...]
  ```
  
  It loads the project with ts-morph, rewrites every mechanical change in place, and prints a summary and a TODO list. Run it on a clean git tree, while the 0.8 packages are still installed, and review the diff.
  
  - **Type-driven rewrites**, which read the 0.8 types:
    - `root.x` → `root.api.x` where the root's type declares `x`, and `root.__debug` → `root.debug`;
    - `form.value.value` → `form.value` for a `Form` or `FieldArray`, and `resetWithInitial` → `setAsInitial`;
    - `promise()` → `firstValue()`, and `useMutation`'s `mutateAsync` → `run`;
    - `ctx.field(...)` → `createField(ctx, ...)` and the rest of the ctx primitives, with their imports.
  - **Syntactic rewrites:**
    - `queryId` and `mutationId` → `id`, and `crossTab` and `persist` → `meta`;
    - `mutate(vars, signal)` and `createCache`'s fetcher → the `{ signal, deps }` context;
    - `createRoot` gains `queries: queryEngine({ defaults })`, which takes over `defaultQueryOptions` and the refetch flags;
    - the positional `createField`, `clearPersisted` and `entitiesPlugin` arguments become options objects.
  - **Renames:** `use` → `useValue`, `KeepAlive` → `SuspendOnUnmount`, the `use*` composables → `create*`, `formFromZod` → `createZodForm`, `selection` → `createSelection`, `useController(root)` → `root.api`, and more.
  - **TODOs** mark what needs a human, with a one-line hint each. Examples are `ctx.session`, a `form.submit` result the code reads, `applyDehydratedEntry`, hooks on a `defineMutation`, the old plugin API, and a spec passed through a variable.
  
  The README lists every transform, every TODO category, and the changes the codemod leaves alone.

### Patch Changes

- b89d091: **`use-controller` rewrites `useController` behind a namespace import.**
  
  A call through a namespace import, `OlasReact.useController(root)` after `import * as OlasReact from '@kontsedal/olas-react'`, was neither rewritten nor reported. The migrated code then failed to compile against 1.0. The call now becomes `root.api`, and any other use of `OlasReact.useController` is reported.
