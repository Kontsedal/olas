# Wiki index

Catalog of every authoritative page in `.wiki/`. Read this first.

The schema and the wiki conventions live in `../CLAUDE.md`. The pattern itself is in `../WIKI_SPEC.md`. The authoritative library design is `../SPEC.md` (with section pointers like §6.1).

## Overview & glossary

- [overview.md](overview.md) — one-page architecture of the whole repo
- [glossary.md](glossary.md) — domain vocabulary

## Modules

- [modules/signals.md](modules/signals.md) — reactive primitives (`signal`, `computed`, `effect`, `batch`, `untracked`)
- [modules/controller.md](modules/controller.md) — `defineController`, `createRoot`, `ctx`, lifecycle
- [modules/query.md](modules/query.md) — the query engine: local cache, shared queries, infinite queries, mutations, SSR, and the query half of the plugin host
- [modules/forms.md](modules/forms.md) — `Field`, `Form`, `FieldArray`, stdlib validators
- [modules/emitter.md](modules/emitter.md) — standalone + controller-bound emitters
- [modules/timing.md](modules/timing.md) — `debounced` and `throttled` signal projections
- [modules/devtools.md](modules/devtools.md) — `DebugEvent` bus behind `root.debug`
- [modules/errors.md](modules/errors.md) — `ErrorContext`, `dispatchError`
- [modules/zod.md](modules/zod.md) — `@kontsedal/olas-zod`: `zodValidator`, `createZodForm`
- [modules/persist.md](modules/persist.md) — `@kontsedal/olas-persist`: `createPersisted`, `persistQueryCachePlugin`
- [modules/realtime.md](modules/realtime.md) — `@kontsedal/olas-realtime`: `createRealtimePatcher` + `createLiveStream` over a consumer-supplied `RealtimeService`
- [modules/cross-tab.md](modules/cross-tab.md) — `@kontsedal/olas-cross-tab`: `BroadcastChannel`-backed cross-tab in-memory query cache sync
- [modules/mutation-queue.md](modules/mutation-queue.md) — `@kontsedal/olas-mutation-queue`: best-effort persistent replay queue for `persist:true` mutations (reload + reconnect + cross-tab-coordinated)
- [modules/router.md](modules/router.md) — `@kontsedal/olas-router`: `createRouterAdapter` bridging TanStack Router and React Router v6 into `RouteParams`/`Search`/`Pathname` scopes
- [modules/entities.md](modules/entities.md) — `@kontsedal/olas-entities`: `defineEntity` + auto-walk + reverse-index backprop, a v2 plugin with the store as the `Entities` scope
- [modules/react.md](modules/react.md) — `@kontsedal/olas-react`: provider + `useSyncExternalStore`-backed hooks; fine-grained `useQuery`, `useInfiniteQuery`, runs under `preact/compat`
- [modules/vue.md](modules/vue.md) — `@kontsedal/olas-vue`: `olasPlugin` + signals as read-only refs
- [modules/svelte.md](modules/svelte.md) — `@kontsedal/olas-svelte`: `setRoot`/`getRoot` + store views; a signal is a Svelte store as it is
- [modules/devtools-panel.md](modules/devtools-panel.md) — `@kontsedal/olas-devtools`: in-app `<DevtoolsPanel>` over `root.debug`
- [modules/eslint-plugin.md](modules/eslint-plugin.md) — `@kontsedal/olas-eslint-plugin`: eight syntax-only rules, the configs, and the example-app lint check
- [modules/codemod.md](modules/codemod.md) — `@kontsedal/olas-codemod`: the 0.8 → 1.0 migration CLI, its seventeen ordered transforms, the edit engine and the TODO list
- [modules/examples.md](modules/examples.md) — the five runnable example apps in `examples/`

## Entities

- [entities/ctx.md](entities/ctx.md) — the tree-and-lifetime handle passed to every controller factory; the primitives take it as their first argument
- [entities/controller-instance.md](entities/controller-instance.md) — the runtime object; lifecycle entry list
- [entities/entry.md](entities/entry.md) — `Entry<T>` — race-protected state machine per cache key
- [entities/query-client.md](entities/query-client.md) — per-root entry registry
- [entities/mutation.md](entities/mutation.md) — `MutationImpl` — concurrency modes + abort-race
- [entities/scope.md](entities/scope.md) — `Scope<T>` — typed cross-tree data slot (provide/inject)

## Flows

- [flows/query-subscription.md](flows/query-subscription.md) — `createQuery(ctx, query, key)` → bind → fetch → React
- [flows/mutation-concurrency.md](flows/mutation-concurrency.md) — parallel, latest-wins and serial paths
- [flows/ssr.md](flows/ssr.md) — `waitForIdle → dehydrate` (server) → `hydrate` (client)
- [flows/construction-rollback.md](flows/construction-rollback.md) — factory throws → partial state torn down
- [flows/use-root.md](flows/use-root.md) — `createRoot` → `<OlasProvider>` → `useRoot()` → `useValue(signal)` → DOM
- [flows/devtools-causal-timeline.md](flows/devtools-causal-timeline.md) — one mutation → one `causeId` → a cause-chain + before/after diff in the panel
- [flows/plugin-lifecycle.md](flows/plugin-lifecycle.md) — `createRoot` → plugin `setup` in order → `onWrite` with origins, `wrapFetch` and `wrapMutate`, `onMutation` → reverse dispose

## Decisions

- [decisions/spec-is-authoritative.md](decisions/spec-is-authoritative.md) — why SPEC.md outranks code
- [decisions/signals-runtime-wrapped.md](decisions/signals-runtime-wrapped.md) — why `@preact/signals-core` is hidden behind our types
- [decisions/per-root-query-client.md](decisions/per-root-query-client.md) — why each root has its own client, not a singleton
- [decisions/brand-markers-not-classes.md](decisions/brand-markers-not-classes.md) — why `Symbol.for(...)` over `instanceof`
- [decisions/no-react-adapter-yet.md](decisions/no-react-adapter-yet.md) — why `@kontsedal/olas-react` is an empty shell
- [decisions/canonical-vs-optimistic-writes.md](decisions/canonical-vs-optimistic-writes.md) — why `Query` has two write methods (`setData` optimistic, `write` canonical) rather than one with an options bag
- [decisions/no-vanilla-adapter.md](decisions/no-vanilla-adapter.md) — why olas ships no vanilla DOM adapter: one was built, measured and dropped
- [decisions/framework-adapters.md](decisions/framework-adapters.md) — why React, Vue and Svelte (and Preact through compat), how each maps a signal, and what the adapter-parity suite proves
- [decisions/ctx-primitives-are-free-functions.md](decisions/ctx-primitives-are-free-functions.md) — why `createField`/`createQuery` take `ctx` instead of hanging off it, and why `createRoot` takes an explicit query engine
- [decisions/root-handle-separate.md](decisions/root-handle-separate.md) — why `createRoot` returns a handle with the app api on `.api` instead of the api with root controls mixed in
- [decisions/disabled-subscriptions.md](decisions/disabled-subscriptions.md) — what a subscription does while `enabled` is false: `isEnabled`, `QueryDisabledError`, a `firstValue` that waits (suspense on a dependent query)
- [decisions/duration-naming.md](decisions/duration-naming.md) — milliseconds everywhere; `*Time` for core's lifetime policies, `*Ms` for every other knob
- [decisions/typed-use-root.md](decisions/typed-use-root.md) — `useRoot()` typed through an augmented `Register`; why `createOlasContext` and `useFieldInput` stay
- [decisions/infinite-query-parity.md](decisions/infinite-query-parity.md) — how infinite queries reach parity: `pageParams` on dehydrated entries and write events, hydration seeding, focus/reconnect, the `offlineFirst` park, cross-tab, devtools
- [decisions/engine-assurance.md](decisions/engine-assurance.md) — property models (fast-check), per-package coverage gates and the Stryker run; the 29 bugs they found before 1.0
- [decisions/benchmarks.md](decisions/benchmarks.md) — how Olas is benchmarked against raw preact signals, MobX and TanStack Query core, the 1.0 results, and the two teardown costs they exposed
- [decisions/trust-model.md](decisions/trust-model.md) — what Olas trusts and checks, and the 1.0 security pass: findings by severity, fixes and tests (SPEC §22)
- [decisions/devtools-overhaul.md](decisions/devtools-overhaul.md) — the devtools overhaul; 8A landed (ring buffer, windowed lists, keyed tree, omnibox, plugin lanes); 8B–8D open
- [decisions/esm-only-build.md](decisions/esm-only-build.md) — why every package ships ESM only on Node >= 20.19, and the dist checks: types, tree-shaking, size
- [decisions/forms-are-read-signals.md](decisions/forms-are-read-signals.md) — why `Form` and `FieldArray` are `ReadSignal`s of their value, like `Field`, and why `submit` resolves a union
- [decisions/required-id-and-meta.md](decisions/required-id-and-meta.md) — why every shared query and defined mutation needs a hand-written `id`, and why plugin settings live in a typed `meta`
- [decisions/plugin-host-v2.md](decisions/plugin-host-v2.md) — plugins as per-root `setup(host)` definitions: the host, the write vocabulary and origins, middleware, services via scopes, and what the old `QueryClientPlugin` got wrong
- [decisions/prose-rules.md](decisions/prose-rules.md) — the writing rules every `.md` follows, what `pnpm prose:lint` enforces, and what it flags that we leave alone
- [decisions/docs-site.md](decisions/docs-site.md) — the VitePress site: guides written in `docs/`, the repo docs synced in with their links rewritten, the api-documenter reference, the checked-in API reports, and why deploying is manual
- [decisions/zod-schema-rules.md](decisions/zod-schema-rules.md) — why createZodForm enforces object and array rules with one whole-schema validator that drops what a leaf already shows, installed only when the schema has such a rule
- [decisions/typechecked-doc-snippets.md](decisions/typechecked-doc-snippets.md) — why every ts/tsx block in the user-facing docs compiles in CI, one program per doc, and the `snippet-prelude` / `file=` / `nocheck` annotations
- [decisions/toolchain.md](decisions/toolchain.md) — the dev toolchain: TypeScript 7 beside the 6.0 API, Node 22.22 to build and 20.19 to consume, pnpm 12's install policies, the vitest 5 migration
- [decisions/peer-bump-guard.md](decisions/peer-bump-guard.md) — why `check:peer-bumps` exists: changesets 3 releases a package whose peer range a release leaves behind as a patch
- [decisions/ui-rules.md](decisions/ui-rules.md) — the ten rules every interface follows, the scales they are picked from, what makes a screen read as generated, and which of the ten anything checks

## Pitfalls

- [pitfalls/callargs-vs-keyargs.md](pitfalls/callargs-vs-keyargs.md) — two args arrays in `ClientEntry`
- [pitfalls/latest-wins-rollback-order.md](pitfalls/latest-wins-rollback-order.md) — rollback BEFORE new `onMutate`
- [pitfalls/isstale-needs-timer.md](pitfalls/isstale-needs-timer.md) — `Date.now()` doesn't trigger re-derivation
- [pitfalls/raceabort-for-misbehaving-mutate.md](pitfalls/raceabort-for-misbehaving-mutate.md) — wrap mutate in `raceAbort`
- [pitfalls/literal-type-narrowing.md](pitfalls/literal-type-narrowing.md) — `createField` infers `T` from `initial`: with validators `''` sticks as `Field<''>`, and `null` gives `Field<null>`
- [pitfalls/preact-signals-overload-return.md](pitfalls/preact-signals-overload-return.md) — `ReturnType<typeof signal<T>>` is wrong
- [pitfalls/fieldarray-factory-uses-initial.md](pitfalls/fieldarray-factory-uses-initial.md) — `add(x)` only works if factory uses it
- [pitfalls/suspended-effects-lose-deps.md](pitfalls/suspended-effects-lose-deps.md) — an effect that early-returns before its tracked reads goes inert
- [pitfalls/raf-unbound-illegal-invocation.md](pitfalls/raf-unbound-illegal-invocation.md) — native `requestAnimationFrame` assigned unbound throws "Illegal invocation" in real browsers (jsdom hides it)
- [pitfalls/dispose-order-is-registration-order.md](pitfalls/dispose-order-is-registration-order.md) — teardown is one reverse-registration pass, not phased; an `onDispose` hook reaches an effect only if the effect was created first
- [pitfalls/no-invalidator-still-refetches.md](pitfalls/no-invalidator-still-refetches.md) — "nothing invalidates this query" is not grounds to skip `cancel()` before an optimistic `setData`: a stale entry refetches on subscribe and `resume()` with no invalidator anywhere
- [pitfalls/proto-key-assignment.md](pitfalls/proto-key-assignment.md) — rebuilding an object with `out[key] = value` swaps its prototype when the key is `__proto__`, and `JSON.parse` can put one in a payload
- [pitfalls/stream-chunks-split-tags.md](pitfalls/stream-chunks-split-tags.md) — a server-rendered stream's chunks can end inside a tag or attribute; anything written between two chunks has to check where it lands
- [pitfalls/node-localstorage-shadows-jsdom.md](pitfalls/node-localstorage-shadows-jsdom.md) — on Node 25+, Node's own `localStorage` global (undefined without a flag) hides jsdom's, so jsdom tests silently skip storage
- [pitfalls/persisted-state-breaks-hydration.md](pitfalls/persisted-state-breaks-hydration.md) — `createPersisted` reads localStorage during construction, so a returning visitor's first client render disagrees with the server HTML
- [pitfalls/dts-export-context.md](pitfalls/dts-export-context.md) — a bundled `.d.ts` with no export list exports every top-level declaration; rolldown-plugin-dts 0.28.2+ drops the list, so entities appends `export {}`
- [pitfalls/render-phase-root-leak.md](pitfalls/render-phase-root-leak.md) — a root built in render and disposed in an effect leaks when React discards the render (a child suspends before the first commit); `HydrationBoundary` reuses it on retry and sweeps it once idle

## Candidates (not authoritative)

Speculative and unbuilt — excluded from authoritative queries. New low-evidence inferences go into `candidates/<type>/`.

- [candidates/backlog.md](candidates/backlog.md) — staging backlog of substantial forward-looking **proposals** (rich design candidates); complements the terse repo-root `BACKLOG.md`
