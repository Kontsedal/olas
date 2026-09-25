# BACKLOG

The grab-bag for future work, ideas-in-progress, and post-v1 proposals.

**This is the only place such items live.** They do not live in `SPEC.md`, the design contract for what *is*. They do not live in `CLAUDE.md`, which is operating instructions. They do not live in `.wiki/`, which describes the codebase as it stands. When you notice anything during work — a follow-up, a stray thought, "we should also…", "this would be cleaner if…" — append it here.

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
- Cite `SPEC.md §X.Y` when an item amends the spec; that signals "spec change required, not only an implementation."
- If a backlog item is implied by an existing spec line, quote the line.

**The 1.0 BACKLOG pass emptied the backlog of open work.** That pass (2026-09-25, `.wiki/log.md`) implemented every item worth doing and dropped the rest, with the reasons below. What remains planned is the release itself: merging `release/1.0` to `main` and reviewing the Version Packages PR.

---

## Release

### [planned] Move the docs site to the Actions deploy once release/1.0 is on main

[from W14] The site is live at https://kontsedal.github.io/olas/, served from the `gh-pages` branch ("Deploy from a branch"). `docs.yml` could not deploy it: GitHub dispatches only workflows that exist on the default branch, and the `github-pages` environment allows only `main`. Once `docs.yml` is on `main`, switch Pages to GitHub Actions (`gh api -X PUT repos/Kontsedal/olas/pages -f build_type=workflow`), run the Docs workflow with `deploy` ticked, and delete the `gh-pages` branch. Until then, a docs change goes live only by rebuilding the site and pushing it to `gh-pages` by hand.

### [idea] Put the framework picker on the other guides' view code

The home page and Getting started show React, Vue or Svelte through `<FrameworkPicker />` and `<ForFramework>` (`.wiki/decisions/docs-site.md`). Mutations, Forms and Testing each show one React view block, and send Vue and Svelte readers to the adapter pages. Each of those blocks could gain its Vue and Svelte versions behind the same picker.

## Toolchain

### [planned] Take vitest 5.0.2 and size-limit 14.0.1 once pnpm's release-age window passes

pnpm 12 refuses a version published less than a day ago (`.wiki/decisions/toolchain.md`). On 2026-09-25 that held `vitest` and `@vitest/coverage-v8` at 5.0.1, and `size-limit` and `@size-limit/preset-small-lib` at 14.0.0. From 2026-09-26, `pnpm update -r --latest` takes them. `@vitest/coverage-v8` is pinned exactly, so it must match `vitest`.

### [idea] Drop the `@typescript/typescript6` alias once TypeScript 7 has an API

`typescript` points at the 6.0 API because typescript-eslint, svelte-check, vue-tsc, rolldown-plugin-dts and `scripts/check-doc-snippets.ts` call it, and TypeScript 7.0 ships none. TypeScript 7.1 is to ship a new API. Once those five run on it, depend on `typescript@7` alone, in the root and in `examples/vue-tasks`, and try `dts: { generator: 'tsgo' }` in tsdown, comparing the `.d.ts` output through `pnpm api:check`.

### [idea] Remove entities' `dts-export-marker` plugin once rolldown-plugin-dts keeps `export {}`

rolldown-plugin-dts 0.28.2+ drops the export list from a chunk whose exports are all inline, which leaks private declarations (`.wiki/pitfalls/dts-export-context.md`). `packages/entities/scripts/dts-export-marker.ts` puts `export {}` back. No upstream issue has been filed yet. When a release fixes it, delete the plugin and confirm `pnpm api:check` still passes.

### [idea] Benchmark Olas through its built entry, not its source

vitest 5 warns that the benchmarks read core's exports through module-runner getters, and the libraries they are compared with load as plain Node modules (`.wiki/decisions/benchmarks.md`). Importing `@kontsedal/olas-core` from its built `dist/` in the bench project, or disabling the module runner there, would remove the cost. The 2026-09-24 ratios would need re-measuring.

### [idea] Publish with npm trusted publishing instead of `NPM_TOKEN`

`publish.yml` writes a long-lived token to `~/.npmrc` for pnpm (`.wiki/decisions/toolchain.md`). npm's trusted publishing authenticates the workflow through OIDC with `id-token: write`, so no token exists to leak, and pnpm 11+ supports it. It needs each package configured on npmjs.com first.

## Packages

### [idea] `gcTime: NaN` and `maxIdleTime: NaN` never expire

`scheduleExpiry` reads `NaN` as "never", as it reads `Infinity`. The retry sleep and the `debounced`/`throttled` windows now read `NaN` as 0, but an entry with `gcTime: NaN` is never collected, and `suspend({ maxIdleTime: NaN })` never disposes. Reading `NaN` as 0 there would drop or dispose at once, which is no safer, so the better fix is a development warning at the option, as `refetchInterval` already warns (`packages/core/src/expiry-timer.ts`).

### [idea] A `refetchInterval` tick can land over a live optimistic write

A subscriber, focus, reconnect or `prefetch` that wants a fetch while an optimistic write is live now waits for the write to settle (SPEC §5.9). An interval tick does not: it skips only while fetching, paused or hidden, never consults staleness, so its response can overwrite the guess on screen, and a later rollback restores that response. Holding the tick back the same way would close it, at the cost of a polled query going quiet for the length of a slow mutation (`packages/core/src/query/client.ts`, the interval handler).

### [idea] A mutation-queue collapse during a replay of its entry sends beside the replay

A `dedupeBy` run that collapses onto an entry while a replay of that entry is out goes to the server at once, beside the replay. The two requests can land in either order, so an autosave can end on the older draft. The entry itself is safe: the replay's success keeps the rewrite (`.wiki/pitfalls/success-drops-a-rewritten-entry.md`). Making the collapse wait for the replay would close it, through the entry's Web Lock in the tab that replays and some signal the tab that holds the key can see. That adds a wait before a live request and a second cross-tab channel (`packages/mutation-queue/src/plugin.ts`, `record` and `replayEntry`).

### [idea] `ctx.provide` after dispose writes into the dead controller

`ctx.provide` has no `assertLive` guard. After dispose it creates or updates the dead instance's scope map and bumps the root-wide `scopesVersion`, which invalidates every live `inject` memo for nothing. §4 lists the factories that throw after dispose and the reads that do not. `provide` is a write that is neither, so a guard would be a small API decision (`packages/core/src/controller/instance.ts`, `provide`).

### [idea] `v-model` on a member of an object-valued field in Vue

`useField(field).value` returns the field's value object, so `v-model="value.name"` assigns on it in place and nothing calls `field.set`. A proxy on the ref's value whose `set` trap writes a copy through `field.set` would make it work, at the cost of the value's identity for every reader, and it would need care for arrays and nesting. SPEC §16.2 names the workaround, a writable `computed` (`packages/vue/src/index.ts`, `useField`).

### [idea] Make `HydrationBoundary`'s release grace configurable

A cleanup suspends the boundary's root and disposes it after `RELEASE_GRACE_MS`, one minute, because React runs the same cleanups for an unmount and an `<Activity>` hide. An app that keeps a hidden `<Activity>` for longer loses the root on show, and an app that remounts its boundary often keeps a suspended root, with its plugins, for that minute. A prop could set the grace, if an app needs another value (`packages/react/src/context.ts`, `.wiki/pitfalls/effect-cleanup-not-unmount.md`).

## Dropped

Each entry says why, so the idea does not come back without new information.

### [dropped] `@kontsedal/olas-offline` — an offline-first layer atop the mutation queue

The pieces exist. `@kontsedal/olas-mutation-queue` persists and replays writes through the core runner, with `retry` and `isRetryable`. `createConnectionState` in `@kontsedal/olas-realtime` is the connection signal, and `networkMode: 'offlineFirst'` parks queries. Conflict resolution is specific to each app's data. A package that bundles those opinions would be one more thing to version for little gain.

### [dropped] A framework-agnostic `bindField(el, field, opts)`

It was salvaged from the vanilla adapter, which was itself dropped. Every shipped adapter already binds a field: React through `useField` / `useFieldInput`, Vue through `useField`'s writable ref and `v-model`, Svelte through `fieldStore` and `bind:value`. A DOM binder with no adapter to serve has no user.

### [dropped] `@kontsedal/olas-vite-plugin` for HMR

The recommended HMR shape, a full root rebuild (`root.dispose()`, then `createRoot(...)`), is about ten lines in the app. A plugin would add a package and a Vite version range to support for no new capability.

### [dropped] A devtools browser extension

The in-app `@kontsedal/olas-devtools` panel covers the same surfaces. An extension is a separate product, with store listings, a messaging bridge into the page and per-browser builds. SPEC §20.9 commits the `DebugEvent` contract, so an extension can still be built against it.

### [dropped] The rest of the devtools overhaul (T8.5 tracing, T8.6 live actions, T8.7 environment simulation and forms inspector, T8.9 session traces, T8.10 UX pass)

The panel covers the controller tree, the cache with subscriber counts, mutations, the causal timeline and plugin lanes. The remaining design is a large project on its own, with no user asking for it yet. `.wiki/decisions/devtools-overhaul.md` keeps the design. The one prerequisite with value on its own, subscriber events, shipped.

### [dropped] Timeline group ordering by most-recent activity

Groups sort by their first event, so a group never moves once it appears. Ordering by last activity would make long-running groups jump around the timeline, which is harder to follow than the current order.

### [dropped] Causal ordering across mutation ids in the mutation queue

Entries replay in order within one mutation `id`, and different ids replay independently. Cross-id ordering needs a dependency graph plus cross-tab agreement on it. Modelling dependent steps under one `id`, or making the server idempotent, covers the real cases, and the package README says so.

### [dropped] A causality guarantee for cross-tab sync

`BroadcastChannel` connects tabs of one origin on one device, and last-message-wins is the guarantee the plugin documents. An optimistic write that a peer mirrors is avoided with `optimistic: false`. A tab that has not bound a query has nothing to update, and it fetches when it binds. Version vectors would cost every message for a conflict the same user on the same machine rarely creates.

### [dropped] A path-typed `form.fieldAt('a.b.c')` lookup

Nested access (`form.fields.a.fields.b`) covers the cases. Template-literal path types slow the compiler on deep schemas, and they would give a second way to reach every field.

### [dropped] A `defineController` generic for per-root deps

One app-wide `AmbientDeps` is the design, and `createRoot` now checks `deps` against it. Threading a per-root deps type through `ControllerDef`, `ctx.child`, `ctx.attach` and `ctx.collection` would touch every controller signature. A helper parameter, as `@kontsedal/olas-realtime` uses, covers the rare app with two differently-typed roots.

### [dropped] `root.replaceController(path, newDef)` for in-place HMR

It would need subscription rebinding and prop reconciliation for a gain the full root rebuild already gives, since the query cache survives a rebuild within `gcTime`.

### [dropped] The signal wrappers' fan-out cost

The measured 1.30× gap came mostly from the order of the cases in the bench file. Run in separate processes against the built package, Olas is within 1–4% of raw `@preact/signals-core`, and removing the wrappers would save about 4% while changing behaviour. `.wiki/decisions/benchmarks.md` has the measurements.

### [dropped] Extracting the example UI components into `examples/_shared/ui/`

The tokens are shared. The components are written in two idioms (plain CSS classes in kanban, Tailwind strings elsewhere), and three call sites are not a component library.

### [dropped] A src-to-src typecheck for the satellites and the integration suite

They typecheck against core's built `dist`, and CI builds first. Project references plus an ambient `__DEV__` would buy a local-only convenience: seeing a core type change without a rebuild.

### [dropped] Running the codemod over the 0.8 examples in CI

It needs the 0.8 packages installed from npm inside CI. The codemod is a one-shot migration, it was checked once against all four 0.8 example apps, and its own fixture tests cover every transform.

### [dropped] Pages for exports whose names differ only in case, in the generated reference

It affects one export: core's `validator()` function, whose page `Validator`'s overwrites. API.md documents the function. A workaround would mean post-processing api-documenter's output for a single page.

### [dropped] Reporting the tsdown `banner` caching bug upstream

Filing an issue in another project is not work in this repo, and it is the maintainer's call. The codemod works around it by putting its shebang at the top of `src/cli.ts`.

### [dropped] Automated candidate promotion, contradiction detection and confidence decay in `wiki-lint`

Each needs judgment a script cannot make: whether evidence confirms a candidate, whether two pages really disagree, whether an old claim still holds. CLAUDE.md lists them as manual lint passes, and `wiki-lint` automates the mechanical checks: frontmatter, paths, orphans, staleness, drift and drifted citations.

### [dropped] A React hook that creates a query subscription (`useQuery(query, { key })`)

Requested implicitly by every consumer that has a React **context or hook** needing server data with no controller of its own (theme provider, feature-flag gate, keybinding overrides). `useQuery(subscription)` can only read a subscription a controller made; there is no `useQuery(query, { key })` that mints one.

Dropped on purpose. A component that creates a cache subscription owns data lifetime, which is precisely what §1 moves out of the view. The escape hatch would also be reached for far beyond the provider case, because it is strictly less typing than routing a read through a controller. The supported answer is the **reads-factory** pattern (`RECIPES.md`): a controller owns the subscriptions, exposes them as an object, React reads them by identity via `useRoot()` + `useQuery(sub)`. If this resurfaces, the thing to reconsider is whether the *recipe* is discoverable enough, not whether the hook should exist.

### [dropped] Next.js app-router / RSC support

Next.js is misaligned with olas's philosophy: the controller-tree model assumes a client-driven, signal-reactive runtime where lifecycle, dispose, and `createQuery` keying live in user space. RSC inverts that — the server owns rendering, components are render functions of props, and the framework dictates data-fetching boundaries. Bolting olas onto that model leads to one of two bad outcomes. It makes olas a thin pass-through to whatever Next.js already does, which defeats the point. Or it requires a parallel server-side controller runtime, doubling the surface area for an audience already well served by TanStack Query and `'use server'` actions.

**We don't need Next.js.** Olas is for logic-heavy client-driven apps (Linear/Notion class) where the controller tree carries real weight. Pages-router SSR via `dehydrate`/`hydrate` (already shipped, spec §11) covers the SSR case for the apps that benefit from it. RSC consumers should reach for the framework's native data-fetching story.

Keep this entry as a reference: future contributors will ask "why not Next?" and the answer needs to be findable.
