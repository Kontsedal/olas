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

### [idea] `@kontsedal/olas-offline` — offline-first reconnection layer atop the mutation queue

`@kontsedal/olas-mutation-queue` (shipped 0.0.5) covers durable enqueue + reload-replay for `defineMutation({ persist: true })`. The remaining offline layer would add: navigator-online detection, connection-state signal, conflict-resolution helpers, exponential-backoff schedule for inter-attempt waits, and an opinionated retry policy mid-session (today the queue only retries across page loads). Likely a thin package layered on top of `mutation-queue` + `@kontsedal/olas-persist`.

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

### [planned] Router adapter packages — phase 0.2b

`RECIPES.md` already documents the router-bridge pattern (TanStack Router + React Router v6) — recipes are sufficient for most apps. The dedicated `@kontsedal/olas-router-tanstack` and `@kontsedal/olas-router-react-router` packages still pending: each ships a small `<OlasRouterBridge>` component plus `RouteParamsScope` / `RouteSearchScope` / `RoutePathnameScope`. Effort: ~1 wk total. Low priority — recipes cover the 90% case.

### [dropped] Next.js app-router / RSC support

Next.js is fundamentally misaligned with olas's philosophy: the controller-tree model assumes a client-driven, signal-reactive runtime where lifecycle, dispose, and `ctx.use` keying live in user space. RSC inverts that — the server owns rendering, components are render functions of props, and the framework dictates data-fetching boundaries. Trying to bolt olas onto that model would either (a) make olas a thin pass-through to whatever Next.js already does, defeating the point, or (b) require a parallel server-side controller runtime, doubling the surface area for an audience that's already well served by TanStack Query and `'use server'` actions.

**We don't need Next.js.** Olas is for logic-heavy client-driven apps (Linear/Notion class) where the controller tree carries real weight. Pages-router SSR via `dehydrate`/`hydrate` (already shipped, spec §11) covers the SSR case for the apps that benefit from it. RSC consumers should reach for the framework's native data-fetching story.

Keep this entry as a reference: future contributors will ask "why not Next?" and the answer needs to be findable.

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
