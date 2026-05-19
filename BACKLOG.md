# BACKLOG

The grab-bag for future work, ideas-in-progress, and post-v1 proposals.

**This is the only place such items live.** They do not live in `SPEC.md` (which is the design contract for what *is*), they do not live in `CLAUDE.md` (which is operating instructions), and they do not live in `.wiki/` (which describes the codebase as it stands). When you notice anything during work — a follow-up, a stray thought, "we should also…", "this would be cleaner if…" — append it here.

## How to use this file

- **Append-only by convention.** Don't reorder or rewrite history without a reason; tag items as the world moves around them.
- **Status tags** at the start of each item's heading:
  - `[idea]` — sketch, not committed to.
  - `[planned]` — agreed on, not started.
  - `[in-progress]` — actively being worked.
  - `[done]` — landed; left here with the commit / spec section that absorbed it, so the trail isn't lost.
  - `[dropped]` — explicitly decided against; the reasoning matters.
- **Move out, don't delete.** When an item lands in the code, change its status to `[done]` and add a one-line pointer to where it lives now (commit hash, spec section, wiki page). When it's killed, mark `[dropped]` with the reason. Both are searchable later.
- **One heading per item.** A short body — context, constraints, what would change, where it'd land. If it grows large, link out to a wiki page or a draft RFC.

## Conventions

- Group by area (Packages, Storage, Devtools, Forms, …). Pure-idea items can live under "Loose ends" until they earn a category.
- Cite `SPEC.md §X.Y` when an item amends the spec; that signals "spec change required, not just an implementation."
- If a backlog item is implied by an existing spec line, quote the line.

---

## Packages

### [planned] `@kontsedal/olas-entities` — entity normalization layer

[SPEC §18.1] When the same entity (a `Post`, a `User`) appears in many queries — newsfeed, profile, search, notifications — updating that entity means patching every query that contains it. Olas core does **not** ship normalized storage; each query owns its own data. The architecture cleanly supports a future entity-normalization package:

- `defineEntity({ name: 'Post', idOf: p => p.id })`.
- Hooks into `setData` and the fetcher pipeline to extract entities into a normalized store.
- `entity.update(id, patch)` diffs and patches every query holding that entity.
- `entity.subscribe(id): ReadSignal<Post | undefined>` for components reading a single entity reactively.

Until this lands, the canonical pattern is one tiny `patchPostEverywhere`-style helper per entity that enumerates the touch sites — verbose but grep-able. See SPEC §18.1 for the worked example.

### [done] `@kontsedal/olas-realtime` — realtime-to-cache patcher

[from SPEC §16.5] The recurring shape "WebSocket / SSE event arrives → patch some queries". The framework primitive (`ctx.effect` + `setData`) is enough; the package wraps the typical dispatching boilerplate. Shipped as `@kontsedal/olas-realtime` (commit `38e2859`, `packages/realtime/src/index.ts`) with both helpers from SPEC §16.5: `useRealtimePatcher<TEvent>(ctx, channel, handlers)` (typed by `event.type` discriminant) and `defineLiveStream<TEvent>(ctx, channel, { capacity, flushMs })` (capped tail buffer + coalesced writes for high-rate streams). Consumers register a `RealtimeService` on `ctx.deps`; the package ships no default transport.

### [idea] `@kontsedal/olas-offline` — offline-first sync / mutation queueing

Persistent outbox + conflict-resolution + retry-on-reconnect for mutations. Today users can layer this themselves over `ctx.mutation` (queue locally, retry on reconnect) and persist via `@kontsedal/olas-persist`. A canonical package would standardize the queue / merge / retry semantics for apps that want a Notion / Linear-style sync model.

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

### [idea] IndexedDB storage adapter for `@kontsedal/olas-persist`

`@kontsedal/olas-persist` ships a `localStorage` adapter today. IndexedDB is a natural next adapter for larger payloads or async-friendly storage.

### [in-progress] Cross-tab cache sync via `BroadcastChannel`

Lives in `@kontsedal/olas-cross-tab` (new package). `QueryClientPlugin` surface added to core. SPEC amendment at §13.2; new query-spec fields `crossTab` and `queryId` (§5.2). See `.wiki/modules/cross-tab.md`.

### [idea] Offline / retry / backoff layer for fetchers

Today users write their own retry logic inside the fetcher (or use the existing `retry` / `retryDelay` per-query options). A reusable middleware layer that handles connection state + exponential backoff + jitter would consolidate the pattern.

## Devtools

### [in-progress] Production build flag to strip `__debug` emission entirely

[from SPEC §23] The devtools machinery is always present in `@kontsedal/olas-core`. `process.env.NODE_ENV !== 'production'` gating already turns subscribers off; the events themselves still fire (a no-op `Set` walk). A compile-time flag (`__DEV__`-style or a tsdown plugin) could elide the emission sites in prod builds.

## Forms

### [idea] Path-typed `form.fieldAt('a.b.c')` lookup

[from SPEC §20.7] The current public API uses the nested `form.fields.a.fields.b.fields.c` access. A `fieldAt<P extends FormPath<S>>(path: P): FieldAt<S, P>` would be ergonomic for deep forms but needs template-literal-type machinery that's implementation-heavy. Nested access covers ~95% of cases today, so this is opportunistic, not blocking.

## Controllers

### [idea] `root.replaceController(path, newDef)` — in-place HMR-friendly swap

[from SPEC §16.5] Surgically replace one controller while preserving siblings and cache subscriptions. Significant complexity (subscription rebinding, prop reconciliation). The current recommended HMR shape (full root rebuild) sidesteps this; revisit only if rebuild ergonomics turn out to be a real friction point.

## Documentation / polish

### [planned] Inline TSDoc on all exported types

Public APIs are typed but not all carry TSDoc. Going through the public surface (per-package `index.ts` re-exports) and writing one or two sentences plus a `@example` per export would materially improve IDE hover.

### [planned] Stdlib composables documentation

`useDebounced`, `usePagination`, `useSubmit` — recurring shapes mentioned across the spec without a single dedicated page. Either a wiki "patterns" page or a `RECIPES.md` section enumerating them with reference implementations.

### [planned] Migration notes

Drafting guides for users coming from TanStack Query and Redux Toolkit (`MIGRATING.md` exists; expand). Specific equivalents: `useQuery` → `ctx.use(query)`, `useMutation` → `ctx.mutation`, slice/reducer → controller, selector → `computed`.

## Loose ends

(nothing tagged yet — drop short, unclassified notes here when they don't fit above)
