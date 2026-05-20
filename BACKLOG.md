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

### [idea] `@kontsedal/olas-entities` — walk `kind: 'infinite'` query payloads

v1 ignores `SetDataEvent`s where `kind === 'infinite'`. The walker would need to traverse `TPage[]` and find entities within each page; `setEntryData` would need an infinite-aware variant. Defer until someone hits the use case.

### [idea] `@kontsedal/olas-entities` — deep-merge option on `update`

Today `entities.update(Post, id, patch)` is `{ ...current, ...patch }`. Nested replacements force the caller to `upsert` a full new value. A `merge: 'shallow' | 'deep'` option (default `'shallow'`) would round out the API.

### [idea] `@kontsedal/olas-entities` — per-entity LRU eviction

Orphaned entity slots (entity once observed, no longer in any query) stay in the store until plugin dispose. For apps with very large entity catalogs, a per-entity-name LRU cap on the slot map would bound memory. Dev builds emit a one-shot warning when a single entity partition crosses 10k unique ids (see `SLOT_BLOAT_WARN_AT` in `packages/entities/src/index.ts`).

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

### [idea] IndexedDB storage adapter for `@kontsedal/olas-persist`

`@kontsedal/olas-persist` ships a `localStorage` adapter today. IndexedDB is a natural next adapter for larger payloads or async-friendly storage.

## Forms

### [idea] Promote root-level Zod `.refine(...)` to a form-level validator in `formFromZod`

`formFromZod` walks `schema.shape` to build leaves; any `.refine(...)` rules on the root `z.object(...)` aren't lifted into a top-level form validator. Workaround: pass `{ validators: [zodValidator(schema)] }` manually to `ctx.form(...)`. Implementing it well needs to split Zod issues by path (root-only vs. field-scoped) so leaf rules aren't double-reported.

### [idea] Path-typed `form.fieldAt('a.b.c')` lookup

[from SPEC §20.7] The current public API uses the nested `form.fields.a.fields.b.fields.c` access. A `fieldAt<P extends FormPath<S>>(path: P): FieldAt<S, P>` would be ergonomic for deep forms but needs template-literal-type machinery that's implementation-heavy. Nested access covers ~95% of cases today, so this is opportunistic, not blocking.

## Controllers

### [planned] Implement `ctx.collection` / `ctx.session` / `ctx.lazyChild`

[from SPEC §11.1, §16.5] The spec describes three dynamic-child primitives that have no implementation yet:

- **`ctx.collection`** (SPEC §11.1) — diff-by-key controller-per-item collection over a reactive source; homogeneous (`controller` + `propsOf`) or factory form (`factory: (item) => { controller, props }`). Drives plugin/block/widget containers (Notion blocks, dashboard widgets, IDE panels).
- **`ctx.session`** (SPEC §11.1) — ephemeral child with explicit `dispose()`. For modals, inline edit sessions, wizards, command palette — child lifetime bounded by either explicit dispose or parent dispose, whichever comes first.
- **`ctx.lazyChild`** (SPEC §16.5) — code-split child controller with lazy module loading + status tracking.

`ctx.attach` (shipping) covers the "ephemeral child with handle" use case for a single item. The collection diffing engine and the factory-per-key shape are the new work. Today, callers building dynamic lists either iterate via `signal<Item[]>` + per-item subscriptions (SPEC §11.2 "rows are data") or open a discrete child via `ctx.attach`.

Implementation requires: key-diff loop driven by an effect, child-per-key bookkeeping with disposal on key removal, factory-form discrimination per `factory(item).controller` identity (reconstruct on type change). Tests would mirror those for `ctx.child` plus diff scenarios.

### [idea] `root.replaceController(path, newDef)` — in-place HMR-friendly swap

[from SPEC §16.5] Surgically replace one controller while preserving siblings and cache subscriptions. Significant complexity (subscription rebinding, prop reconciliation). The current recommended HMR shape (full root rebuild) sidesteps this; revisit only if rebuild ergonomics turn out to be a real friction point.

## Documentation / polish

### [in-progress] Inline TSDoc on all exported types

The major exports carry one-line descriptions (e.g. `defineQuery`, `defineController`, `useField`). What's still missing: `@example` blocks attached to public surfaces and TSDoc on the long tail of utility exports. Going through each package's `index.ts` re-exports systematically and adding one `@example` per primitive would materially improve IDE hover. Worth doing alongside the next API.md sweep.

## Loose ends

(nothing tagged yet — drop short, unclassified notes here when they don't fit above)
