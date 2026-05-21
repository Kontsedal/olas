# BACKLOG

The grab-bag for future work, ideas-in-progress, and post-v1 proposals.

**This is the only place such items live.** They do not live in `SPEC.md` (which is the design contract for what *is*), they do not live in `CLAUDE.md` (which is operating instructions), and they do not live in `.wiki/` (which describes the codebase as it stands). When you notice anything during work — a follow-up, a stray thought, "we should also…", "this would be cleaner if…" — append it here.

## How to use this file

- **Status tags** at the start of each item's heading:
  - `[idea]` — sketch, not committed to.
  - `[planned]` — agreed on, not started.
  - `[in-progress]` — actively being worked.
  - `[dropped]` — explicitly decided against; the reasoning matters.
- **Shipped items are removed.** Once an item lands in the code, delete the entry — the wiki and CHANGELOGs are the durable trail. Dropped items stay (tagged `[dropped]`) because the reasoning matters next time the idea resurfaces.
- **One heading per item.** A short body — context, constraints, what would change, where it'd land. If it grows large, link out to a wiki page or a draft RFC.

## Conventions

- Group by area (Packages, Storage, Devtools, Forms, …). Pure-idea items can live under "Loose ends" until they earn a category.
- Cite `SPEC.md §X.Y` when an item amends the spec; that signals "spec change required, not just an implementation."
- If a backlog item is implied by an existing spec line, quote the line.

---

## Packages

### [idea] `SetDataEvent.source === 'remote'` is redundant with `isRemote === true`

After §13.2 grew the `source: 'set' | 'fetch' | 'remote'` field, `source === 'remote'` carries the same information as `isRemote === true`. They're kept both for back-compat — existing plugins (cross-tab) gate on `isRemote`, new plugins (entities) can gate on `source`. Pick one in v2 and drop the other. Migration: keep `isRemote` (shorter, predates `source`) and reserve `source` strictly for `'set' | 'fetch'`.

### [idea] `@kontsedal/olas-offline` — offline-first sync / mutation queueing + fetcher retry layer

Persistent outbox + conflict-resolution + retry-on-reconnect for mutations, plus a reusable fetcher middleware (connection state + exponential backoff + jitter). Today users layer this themselves over `ctx.mutation` (queue locally, retry on reconnect) and persist via `@kontsedal/olas-persist`; per-query `retry` / `retryDelay` cover the simple backoff cases inline. A canonical package would standardize the queue / merge / retry / reconnect semantics for apps that want a Notion / Linear-style sync model.

### [idea] `@kontsedal/olas-vue` — Vue adapter

Signal/ref interop. Out of scope for v1; the architecture is framework-neutral, so it's additive.

### [idea] `@kontsedal/olas-svelte` — Svelte adapter

Signal-as-store. Same scoping as Vue.

### [idea] `@kontsedal/olas-eslint-plugin` — lint rules that catch correctness issues we can't enforce at the type level

Examples:

- fetcher / `mutate` body must use the `signal` parameter.
- Controller factory must not be `async`.
- Do not import `@kontsedal/olas-core/testing` outside test files.

### [idea] `@kontsedal/olas-vite-plugin` — HMR automation

[from SPEC §16.5] Today's recommended HMR shape is "full root rebuild on hot update" (`root.dispose()` then `createRoot(...)` again, ~10 lines of Vite plugin glue). A first-party plugin would automate this.

### [idea] Devtools browser extension

[SPEC §14] An out-of-page extension that consumes `root.__debug.subscribe(...)` — controller tree inspector, cache timeline, mutation log, signal dependency graph, subscription view. The in-app `@kontsedal/olas-devtools` panel already covers the same surfaces; the extension would make them available without instrumenting the page.

## Storage / sync

## Forms

### [idea] Path-typed `form.fieldAt('a.b.c')` lookup

[from SPEC §20.7] The current public API uses the nested `form.fields.a.fields.b.fields.c` access. A `fieldAt<P extends FormPath<S>>(path: P): FieldAt<S, P>` would be ergonomic for deep forms but needs template-literal-type machinery that's implementation-heavy. Nested access covers ~95% of cases today, so this is opportunistic, not blocking.

### [planned] `form.submit(handler)` lifecycle + `setErrors` for server-side errors — phase 0.1

Add: `form.submit(handler, { validateBeforeSubmit?, resetOnSuccess?, onError? })`, plus signals `isSubmitting` / `submitCount` / `submitError`. Handler runs after `validate()`; on invalid, `markAllTouched()` and bail without calling the handler. Plus `field.setErrors(string[])` and `form.setErrors({ path: [...] })` for server-side error injection — kept in a separate `serverErrors$` so a re-validate doesn't wipe them. Cleared on next user write to the field. RHF / TanStack-Form parity; biggest gap adopters hit today. Effort: 2–3 days.

### [planned] Standard Schema adapter — phase 0.1

Adopt the v1 `~standard` symbol (Zod 4, Valibot 1, ArkType 2). New `validator(schema)` in `@kontsedal/olas-core` accepts any `StandardSchemaV1`; `zodValidator` becomes an alias. `formFromZod` keeps Zod-specific introspection (no library-agnostic introspection exists yet in Standard Schema). Effort: 3–5 days.

## Queries / data layer

### [planned] Structural sharing on refetch + `select` projection — phase 0.1

Refetches today produce a new object identity even when payload content is unchanged, so downstream `computed`s and React re-renders churn unnecessarily. Add `structuralShare(prev, next)` that walks both trees and returns a value re-using `prev`'s refs where the subtree is deep-equal; wire into `Entry.applySuccess` (and the infinite-entry equivalent) before `data.set(...)`. Bail on `Map`/`Set`/`Date`/class instances; cycle-guard with a `WeakSet` like the entities walker.

Layer a `select?: (data: T) => U` option on `useQuery` / subscriptions — a per-subscriber `computed(() => select(subscription.data.value))`. Structural sharing upstream makes `select` outputs stable when their inputs are. Effort: ~1 wk including infinite-query coverage.

### [planned] React 19 `use()` / Suspense integration — phase 0.2

Expose `subscription.promise(): Promise<T>` over `Entry.firstValue()`; resolves on first non-pending settle, rejects on error. Add `useQuery(q, args, { suspense: true })` that throws the pending promise (caught by `<Suspense>`); on `status === 'error'` throw the error (caught by `<ErrorBoundary>`). Document the bare-`use(subscription.promise())` recipe too. Sequence after structural-sharing so concurrent renders see stable values across the suspend / resume boundary. Effort: 1–2 wk.

### [planned] Router integration — phase 0.2

Two layers shipped separately. Layer A: recipes for TanStack Router / React Router v6 / Next pages router in `RECIPES.md` showing the controller pattern (route signal → `ctx.session` switch). Layer B: small adapter packages `@kontsedal/olas-router-tanstack` and `-router-react-router` that provide `RouteParamsScope` / `RouteSearchScope` / `RoutePathnameScope` as `ReadSignal`s + an `<OlasRouterBridge>` component. Next app-router story deferred to RSC. Effort: 3 d recipes + ~1 wk adapters.

### [planned] Persisted mutation queue — phase 0.3

A `RootPlugin` extension (the current `QueryClientPlugin` is too narrow) that captures `defineMutation({ persist: true, mutationId: '...' })` invocations to a `StorageAdapter` and replays them on next root init. Default replay is per-`mutationId`-serial; consumers add an `idempotencyKey` to variables to dedupe against the server. `onMutate` is skipped on replay by default (cache snapshots are gone post-reload); `onConflict` callback is the escape hatch. Touches the mutation API contract, so ship as 0.3 with a migration note. Effort: 1–2 wk.

### [idea] RSC / Next app-router support — phase 0.4 (needs spec re-decision)

SPEC currently rules this out ("Olas runs in the browser; not for RSC apps"). If re-opened: `'use client'` directives on every hook file; `@kontsedal/olas-react/server` entry exporting `dehydrate` + `<HydrationBoundary>` that splits hydration per Suspense boundary so streaming SSR can resolve progressively; `useActionState` adapter wrapping `Mutation` so `<form action={mutation.action}>` works. Per-request roots already exist, which is the structural win that makes this tractable. Effort: 2–3 wk; biggest risk is keeping controller-tree semantics intact across the server/client serialization line. Flag for re-decision before starting.

## Controllers

### [idea] `root.replaceController(path, newDef)` — in-place HMR-friendly swap

[from SPEC §16.5] Surgically replace one controller while preserving siblings and cache subscriptions. Significant complexity (subscription rebinding, prop reconciliation). The current recommended HMR shape (full root rebuild) sidesteps this; revisit only if rebuild ergonomics turn out to be a real friction point.

## Documentation / polish

### [in-progress] Inline TSDoc on all exported types

The major exports carry one-line descriptions (e.g. `defineQuery`, `defineController`, `useField`). What's still missing: `@example` blocks attached to public surfaces and TSDoc on the long tail of utility exports. Going through each package's `index.ts` re-exports systematically and adding one `@example` per primitive would materially improve IDE hover. Worth doing alongside the next API.md sweep.

## Examples

### [idea] Extract `examples/_shared/ui/` design system

The flagship kanban example has a complete in-app design system at
`examples/kanban/src/ui/` — tokens (oklch palette + light/dark/density),
motion keyframes, and ~14 React primitives (Button, Card, Avatar, Tag,
Toast, Dialog, …). When stock-ticker or reader-ssr are next due for a UI
uplift, lift these out to `examples/_shared/ui/` and have each example
extend the tokens. Already deliberately kept kanban-local for now to
avoid premature abstraction — see the `cryptic-questing-twilight.md`
plan for the rationale.

## Loose ends

(nothing tagged yet — drop short, unclassified notes here when they don't fit above)
