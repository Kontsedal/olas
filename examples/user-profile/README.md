# Example — user profile

A worked example covering Olas's main shapes end-to-end. Read this if you want a real, type-checked program rather than scattered snippets.

## What it shows

- **A shared query** (`userQuery`) keyed by user id. Defined once at module scope; consumers point at it.
- **A controller** (`userProfileController`) that subscribes to the query and exposes a Zod-validated form.
- **A reactive form seed** — the form is reset to server values via `ctx.effect`, but only when not dirty.
- **A mutation with an optimistic update** — `onMutate` returns `userQuery.setData(...)`'s `Snapshot` so error rollback is automatic. `onSuccess` invalidates to reconcile with the server.
- **A typed React UI** built on `OlasProvider`, `useRoot`, `useQuery`, `useField`.
- **A typed deps surface** — `declare module '@olas/core'` augments `AmbientDeps` so `ctx.deps.api` is typed everywhere.
- **A scope** (`currentUserScope`) — typed cross-tree data; included as a primitive even though this example doesn't deeply nest.

## Files

- `src/api.ts` — fake API with an in-memory store.
- `src/controller.ts` — query, controller, mutation. **No React.**
- `src/View.tsx` — `<App>`, `<UserProfileCard>`, `<EditForm>`. Thin renderer.
- `src/main.tsx` — bootstrap. Creates the root, renders the React tree.

## Run it

This package is **typechecked** as part of the workspace but is not built or run by CI. To run it standalone you'd need a build tool (Vite, esbuild, …) — pick your favorite, point it at `src/main.tsx`.

```bash
pnpm install
pnpm --filter @olas/example-user-profile typecheck
```

## Read order

If you're new to Olas, read in this order:

1. `src/api.ts` — the fake server.
2. `src/controller.ts` top-to-bottom — query → schema → controller → root factory.
3. `src/View.tsx` — see how the controller's API maps to React hooks.

Then jump to [`../../SPEC.md`](../../SPEC.md) for the full design or [`../../.wiki/overview.md`](../../.wiki/overview.md) for a one-page architecture summary.

## Things deliberately kept simple

- No router — `currentUserScope` would carry the active user across pages in a real app.
- Form has two fields; in production the same `formFromZod` pattern handles deeply nested schemas with arrays.
- No error UI for the mutation — the button just stops spinning. Real apps would surface `api.profile.save.error.value`.
- No tests for the example — the framework's own test suite is the contract; this example is for reading.
