# Deep assessment — findings + suggestions

Snapshot of the library at commit `7a07994` (v0.0.1-rc.1). Items here are intentionally short — once an item is triaged it should be migrated to `BACKLOG.md` per the repo's BACKLOG protocol.

**Status:** all 43 items addressed. 332 tests pass (up from 310). Typecheck + lint + build all green across every package and example.

Severity tags:
- `[bug]` — observable wrong behavior or crash.
- `[drift]` — `SPEC.md` and code disagree; pick one.
- `[leak]` — memory / handle / subscription growth without bound.
- `[smell]` — code-quality issue, no user impact.
- `[gap]` — missing test for a load-bearing surface.

Status markers: `[x]` done, `[ ]` pending.

---

## Spec / code drift

- [x] **[drift] `Snapshot` shape disagreement (runtime-breaking).** `SPEC.md:2081` (§20.4) declares `type Snapshot = { rollback: () => void }`. Code requires `{ rollback, finalize }` — `MutationImpl` calls `snapshot.finalize()` at `packages/core/src/query/mutation.ts:222`. A user-built `Snapshot` written per spec throws `TypeError`. **Fix:** add `finalize` to the spec (preferred — the code is right) or remove `.finalize()` calls and have the mutation runtime track finalization out-of-band.

- [x] **[drift] `invalidateAll` semantics.** `SPEC.md:439` (§5.7) says `userQuery.invalidateAll() // drop every entry for this query`. Code at `packages/core/src/query/client.ts:720-738` marks-stale-and-refetches; it does not drop. **Fix:** decide the behavior (drop vs. invalidate-and-refetch), align both, add a test.

- [x] **[drift] Suspend does not pause `refetchInterval` or `ctx.use` subscriptions.** `SPEC.md:263-265` (§4.1) requires interval timers paused on suspend and stale caches to refetch on resume. `ControllerInstance.suspend` (`packages/core/src/controller/instance.ts:162`) handles only `'effect' / 'child' / 'onSuspend'` entries; `ctx.use` registers as `'cleanup'` (`:279, :287`) and survives suspend. **Fix:** either route cleanup entries through a `suspend()`/`resume()` channel and have `ClientEntry`/`InfiniteClientEntry` expose them, or amend §4.1.

- [x] **[drift] Reactive `Form` `initial` not implemented.** `SPEC.md` §8.4 mandates `initial: () => T` runs in a tracking scope and re-applies on tracked-signal change while the form is not dirty. `packages/core/src/forms/form.ts:64-67, 190-194` invokes it once at construction and once on `reset()`. The wiki acknowledges this (`modules/forms.md:114-116`); the spec does not. **Fix:** implement per spec (wrap in `effect` with a `isDirty` guard) or amend §8.4 + drop `resetOnInitialChange` from §20.7.

- [x] **[drift] `FormOptions.resetOnInitialChange` missing.** Declared at `SPEC.md` §20.7 (~line 2284); absent from `packages/core/src/forms/form-types.ts:47-50`. **Fix:** add the option or remove from spec.

- [x] **[drift] `Form.validate()` doesn't re-trigger top-level validators.** `packages/core/src/forms/form.ts:206-229` awaits child validators and waits for any *currently running* top-level run, but never schedules a fresh top-level pass. `FieldArrayImpl.validate()` (`:475-494`) has the same gap. **Fix:** kick off `runTopLevelValidators` explicitly inside `validate()` and await its completion before returning.

- [x] **[smell] Internal spec inconsistency: `MutationSnapshot` vs `Snapshot`.** `SPEC.md` §6 lines 543-545 use `MutationSnapshot`; §20.5 uses `Snapshot`. **Fix:** pick one name in the spec.

---

## Bugs

- [x] **[bug] `InfiniteEntry` leaks `isFetchingNextPage` / `isFetchingPreviousPage` stuck `true` on supersede.** When a paginated fetch is superseded, the supersede branch at `packages/core/src/query/infinite.ts:312-313` throws AbortError without resetting these flags. The success-path resets at `:240-249` and `:278-287` never run. The UI pagination spinner wedges forever. **Fix:** reset both flags in a `finally` (or before the AbortError throw in the supersede branch). Add a test that triggers two `fetchNextPage()` calls back-to-back and asserts the flags settle to `false`.

- [x] **[bug] `Snapshot` runtime-break per the spec drift above.**

- [x] **[bug] `Mutation.reset()` leaks queued serial runs.** `packages/core/src/query/mutation.ts:299-309` clears `serialQueue.length = 0` without rejecting the queued entries — their promises hang forever. `dispose()` rejects them at `:314-318`; `reset()` should too. **Fix:** mirror `dispose()`'s queue-drain in `reset()`.

- [x] **[bug] `Entry.firstValue()` never settles after dispose.** `packages/core/src/query/entry.ts:263-274` subscribes to `status` and resolves on `'success'`/`'error'` only. `dispose()` aborts the in-flight fetch, which throws AbortError without calling `applyFailure`, so status remains `'pending'`. Propagates through `subscription.firstValue` (`packages/core/src/query/use.ts:72-76`) and `prefetch()` (`client.ts:862-876`). **Fix:** in `dispose()`, reject any outstanding `firstValue` promises and unsubscribe.

- [x] **[bug] Hydrated entries lie about `isStale` when `staleTime > 0`.** `packages/core/src/query/entry.ts:62-70` sets `isStale.set(this.staleTime === 0)` (i.e., `false`) and schedules a fresh `staleTime`-ms timer from "now," regardless of how old `initialUpdatedAt` is. `isStaleNow()` returns the correct answer (used internally for subscribe-time refetch), but the public `subscription.isStale` signal reads `false` until the timer fires. **Fix:** initialize `isStale` from `Date.now() - initialUpdatedAt >= staleTime`; schedule the timer for the remaining time, not a fresh full `staleTime`.

- [x] **[bug] AbortError from invalidate-supersede spams `dispatchError`.** `packages/core/src/query/client.ts:710-716, 729-735, 808-813, 822-827` route rejections from `entry.invalidate().catch(...)` through `dispatchError({ kind: 'cache' })`. Two rapid `q.invalidate()` calls log an error via `defaultHandler` (`errors.ts:19-22`). Mutation paths filter abort; cache invalidate paths don't. **Fix:** add `isAbortError(err)` filter to all four sites.

- [x] **[bug] Sync validator throws are silently swallowed.** `packages/core/src/forms/field.ts:209-216`, `forms/form.ts:251-255`, `forms/form.ts:516-520` invoke validators outside try/catch; a synchronous throw escapes the signal effect and never reaches `dispatchError(onError, ..., { kind: 'effect' })`. The user's `root.onError` sees nothing. **Fix:** wrap each call in try/catch and route via `dispatchError`.

- [x] **[bug] `Form.applyPartial` throws on `undefined` nested form values.** `packages/core/src/forms/form.ts:144-169`: `partial.someNestedForm === undefined` reaches `resetWithInitial(undefined)` → `Object.entries(undefined)`. **Fix:** skip `undefined` values in `applyPartial`.

- [x] **[bug] Persist cross-tab listener drops delete events.** `packages/persist/src/index.ts:135` returns early when `rawValue == null`, which is exactly the `localStorage.removeItem` case. Cross-tab deletes are silently dropped. **Fix:** branch — when `rawValue` is `null`, write `undefined` (or the initial value) through to `source.set` under the `writingFromLoad` flag.

- [x] **[bug] `ctx.effect` called during `suspended` double-creates on resume.** `controller/instance.ts:238-260, :489`. `isTerminal()` returns true only for `'disposed'`; calling `ctx.effect(...)` during suspend pushes an entry whose `dispose` is non-null, and `resume` (`:205`) unconditionally reassigns `dispose`, leaking the original. **Fix:** in `ctx.effect`, when state is `'suspended'`, push the entry but don't activate; let `resume` activate it.

- [x] **[bug] `hydrate({ version: 2 })` silently no-ops.** `packages/core/src/query/client.ts:557-566` returns without warn/error on version mismatch. A schema-bumped payload silently produces an empty cache. **Fix:** at minimum console.warn; consider `RootOptions.onHydrateMismatch?: (incoming, expected) => void`.

- [x] **[bug] `waitForIdle` 100-loop guard silently succeeds.** `client.ts:625-656`. A pathological setup that keeps starting new fetches yields an apparently-clean dehydrate. **Fix:** throw or warn when the loop exits via the guard.

- [x] **[bug] `Query.prefetch(...)` picks an arbitrary client in multi-root.** `packages/core/src/query/define.ts:69-76` does `[first] = clients` over a `Set`. **Fix:** require the caller to pass a client (or root) when more than one is registered; throw with a clear message otherwise.

---

## Leaks

- [x] **[leak] `bindTreeToDevtools` in dynamic FieldArray.** `packages/core/src/forms/form.ts:619-626`. Each change to `items$` re-runs the outer `effect` and recursively recreates child effects per item, all pushed to the same `disposers` array. Over many add/remove cycles, `disposers` grows unbounded. **Fix:** flush previous disposers at the start of each re-bind.

- [x] **[leak] Devtools `mutationStarts` Map is unbounded.** `packages/devtools/src/store.ts:107`. If a mutation's `run` fires but `success`/`error` never does (controller dispose mid-flight), the start record never clears. Not cleared by `clearLogs()`. **Fix:** clear on dispose events; also drain in `clearLogs()`; cap the Map's size.

- [x] **[smell] `Entry.finalizeSnapshot` + `tagSnapshot` are dead code.** `packages/core/src/query/entry.ts:244-303`. Never called. The wiki note at `.wiki/entities/entry.md:65` is misleading — the snapshot's own `finalize()` IS wired (via `mutation.ts:222`). **Fix:** remove `finalizeSnapshot`, `tagSnapshot`, and the `snapshotIds` WeakMap.

---

## Code smells

- [x] **[smell] `abortableSleep` duplicated** between `packages/core/src/query/entry.ts:305` and `packages/core/src/query/mutation.ts:367`. **Fix:** move to `utils.ts`.

- [x] **[smell] `wasSuspended` is dead.** `packages/core/src/controller/instance.ts:112, :134`. Computed, voided to silence lint. **Fix:** remove.

- [x] **[smell] Naming inconsistency in side packages.** `usePersisted(ctx, ...)`, `useRealtimePatcher(ctx, ...)`, and `defineLiveStream(ctx, ...)` are all framework-agnostic Olas composables that take `ctx`. By the spec's own naming convention (`define*` is reserved for module-scope factories), `defineLiveStream` should be `useLiveStream`. **Fix:** rename `defineLiveStream` → `useLiveStream`. (Pre-1.0 freedom.)

- [x] **[smell] Persist (JSON) and cross-tab (structured-clone) serializers diverge.** A `Date` survives `BroadcastChannel` but becomes a string through JSON; a `Map`/`Set` survives `BroadcastChannel` and is dropped by JSON. **Fix:** document the difference in both packages' READMEs; consider a shared `Serializer` interface in core.

- [x] **[smell] Plugin `subscribedKeys` is exposed but unused.** `QueryClientPluginApi.subscribedKeys` is public; no shipped plugin uses it. **Fix:** drop, or add a JSDoc `@example` showing the intended use case (e.g., a plugin that only mirrors actively-subscribed keys).

- [x] **[smell] Cross-tab plugin instance is single-use per root, undocumented.** `packages/cross-tab/src/index.ts` holds one `sourceId`, one channel, one listener Map; passing the same plugin object to two `createRoot(...)` calls clobbers state on the second `init`. **Fix:** either guard against re-`init` (throw with a clear message) or restructure so `init` returns the per-root state. Document either way.

- [x] **[smell] `Mutation.run` signature is a superset of the spec.** Spec §6 (`SPEC.md:551`) declares `run: (vars: V) => Promise<R>`. Implementation exposes a variadic-tuple `MutationRun<V, R>` (`packages/core/src/query/mutation.ts:63-65`). Superset, so no breakage. **Fix:** update the spec to show the variadic shape and explain the `void`/`unknown` cases.

---

## Test gaps (highest-leverage)

- [x] **[gap] `debouncedValidator` has zero tests.** Exported at `packages/core/src/index.ts:25`; only used in `examples/reader-ssr`. Async-validator AbortSignal handling is the highest-footgun surface in the library.
- [x] **[gap] No type-level tests.** `literal-type-narrowing` and `preact-signals-overload-return` are pure type-system pitfalls. Add ~20 LOC of `expectTypeOf` (vitest) assertions; gigantic regression protection.
- [x] **[gap] No test for `InfiniteEntry`'s `isFetchingNextPage` / `isFetchingPreviousPage` ever reaching `true`** — would catch the stuck-flag bug.
- [x] **[gap] No test for `Mutation.reset()` on a `serial` mutation with queued runs** — would catch the queued-leak bug.
- [x] **[gap] No test for `Entry.firstValue()` dispose-while-pending** — would catch the hang.
- [x] **[gap] No test for `invalidateAll` / `invalidateAllInfinite`** — both diverge from the spec.
- [x] **[gap] No test for suspend interacting with `ctx.use` / `refetchInterval`** — would catch the §4.1 drift.
- [x] **[gap] No test for hydrated-stale-with-`staleTime > 0`** asserting `subscription.isStale` reads `true`.
- [x] **[gap] No test for an in-flight mutation at dehydrate time** (current SSR tests only assert `waitForIdle` blocks).
- [x] **[gap] No test for cross-tab plugin reuse across roots.**
- [x] **[gap] No `isStale` timer test for `defineQuery`** — `cache.test.ts:349` covers `ctx.cache`, but `query.test.ts` has no equivalent (both use `Entry`).
- [x] **[gap] No "two concurrent fetches on the same query key, latest-wins"** test for queries. Entry race protection is exercised only transitively (via `keepPreviousData`).
- [x] **[gap] `flush = for(i<10) await Promise.resolve()`** convention in `mutation.test.ts`, `infinite.test.ts`, `form.test.ts` leaks microtask depth into the suite. **Fixed** — every positive assertion converted to `await vi.waitFor(() => expect(...))`; the `flush` helpers removed from the three target files. Three `flush()` calls remain in `regressions.test.ts` at intentional "drain microtasks, assert nothing leaked through" sites (negative assertions where `vi.waitFor` doesn't apply).

---

## Recommended order of attack

If a focused remediation pass is desired, this order maximizes user-visible improvement per hour spent:

1. Reset `isFetchingNextPage`/`isFetchingPreviousPage` in `InfiniteEntry` supersede branches + test.
2. Reconcile `Snapshot` shape between spec and code (add `finalize` to §20.4) + test.
3. Reconcile `invalidateAll` between spec and code + test.
4. Decide and implement suspend pausing `refetchInterval` and `ctx.use` (or amend §4.1).
5. Filter `AbortError` from `dispatchError` on invalidate paths.
6. Initialize hydrated entries' `isStale` from actual age, not `staleTime === 0`.
7. Fix `Entry.firstValue()` dispose-hang.
8. Fix `Mutation.reset()` queued-serial leak.
9. Wrap sync validators in try/catch → `dispatchError`.
10. Flush `bindTreeToDevtools` disposers on FieldArray re-bind.
11. Add `expectTypeOf` tests for the two type-system pitfalls + tests for `debouncedValidator`.
12. Reconcile reactive-`initial` between spec and code; drop or implement `resetOnInitialChange`.

Items 1–8 are concrete bugs and drifts with small blast radius and visible payoff. 9–12 close the long tail.
