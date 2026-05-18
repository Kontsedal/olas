# Wiki index

Catalog of every authoritative page in `.wiki/`. Read this first.

The schema and the wiki conventions live in `../CLAUDE.md`. The pattern itself is in `../WIKI_SPEC.md`. The authoritative library design is `../SPEC.md` (with section pointers like §6.1).

## Overview & glossary

- [overview.md](overview.md) — one-page architecture of the whole repo
- [glossary.md](glossary.md) — domain vocabulary

## Modules

- [modules/signals.md](modules/signals.md) — reactive primitives (`signal`, `computed`, `effect`, `batch`, `untracked`)
- [modules/controller.md](modules/controller.md) — `defineController`, `createRoot`, `ctx`, lifecycle
- [modules/query.md](modules/query.md) — local cache, shared queries, infinite queries, mutations, SSR
- [modules/forms.md](modules/forms.md) — `Field`, `Form`, `FieldArray`, stdlib validators
- [modules/emitter.md](modules/emitter.md) — standalone + controller-bound emitters
- [modules/timing.md](modules/timing.md) — `debounced` / `throttled` signal projections
- [modules/devtools.md](modules/devtools.md) — `DebugEvent` bus
- [modules/errors.md](modules/errors.md) — `ErrorContext`, `dispatchError`
- [modules/zod.md](modules/zod.md) — `@olas/zod`: `zodValidator`, `formFromZod`
- [modules/persist.md](modules/persist.md) — `@olas/persist`: `usePersisted`
- [modules/react.md](modules/react.md) — `@olas/react`: provider + `useSyncExternalStore`-backed hooks
- [modules/devtools-panel.md](modules/devtools-panel.md) — `@olas/devtools`: in-app `<DevtoolsPanel>` over `root.__debug`

## Entities

- [entities/ctx.md](entities/ctx.md) — the lifecycle-bound primitive factory passed to every controller factory
- [entities/controller-instance.md](entities/controller-instance.md) — the runtime object; lifecycle entry list
- [entities/entry.md](entities/entry.md) — `Entry<T>` — race-protected state machine per cache key
- [entities/query-client.md](entities/query-client.md) — per-root entry registry
- [entities/mutation.md](entities/mutation.md) — `MutationImpl` — concurrency modes + abort-race
- [entities/scope.md](entities/scope.md) — `Scope<T>` — typed cross-tree data slot (provide/inject)

## Flows

- [flows/query-subscription.md](flows/query-subscription.md) — `ctx.use(query, key)` → bind → fetch → React
- [flows/mutation-concurrency.md](flows/mutation-concurrency.md) — parallel / latest-wins / serial paths
- [flows/ssr.md](flows/ssr.md) — `waitForIdle → dehydrate` (server) → `hydrate` (client)
- [flows/construction-rollback.md](flows/construction-rollback.md) — factory throws → partial state torn down
- [flows/use-root.md](flows/use-root.md) — `createRoot` → `<OlasProvider>` → `useRoot()` → `use(signal)` → DOM

## Decisions

- [decisions/spec-is-authoritative.md](decisions/spec-is-authoritative.md) — why SPEC.md outranks code
- [decisions/signals-runtime-wrapped.md](decisions/signals-runtime-wrapped.md) — why `@preact/signals-core` is hidden behind our types
- [decisions/per-root-query-client.md](decisions/per-root-query-client.md) — why each root has its own client, not a singleton
- [decisions/brand-markers-not-classes.md](decisions/brand-markers-not-classes.md) — why `Symbol.for(...)` over `instanceof`
- [decisions/no-react-adapter-yet.md](decisions/no-react-adapter-yet.md) — why `@olas/react` is an empty shell

## Pitfalls

- [pitfalls/callargs-vs-keyargs.md](pitfalls/callargs-vs-keyargs.md) — two args arrays in `ClientEntry`
- [pitfalls/field-value-shape.md](pitfalls/field-value-shape.md) — `Field.value` ≠ `Form.value`
- [pitfalls/latest-wins-rollback-order.md](pitfalls/latest-wins-rollback-order.md) — rollback BEFORE new `onMutate`
- [pitfalls/isstale-needs-timer.md](pitfalls/isstale-needs-timer.md) — `Date.now()` doesn't trigger re-derivation
- [pitfalls/raceabort-for-misbehaving-mutate.md](pitfalls/raceabort-for-misbehaving-mutate.md) — wrap mutate in `raceAbort`
- [pitfalls/literal-type-narrowing.md](pitfalls/literal-type-narrowing.md) — `ctx.field('')` infers `Field<''>`
- [pitfalls/preact-signals-overload-return.md](pitfalls/preact-signals-overload-return.md) — `ReturnType<typeof signal<T>>` is wrong
- [pitfalls/fieldarray-factory-uses-initial.md](pitfalls/fieldarray-factory-uses-initial.md) — `add(x)` only works if factory uses it

## Candidates (not authoritative)

None yet. New inferences with low evidence go into `candidates/<type>/`.
