# REMEDIATION.md — deep-audit fix plan (2026-07-25)

**What this is.** A full-repo audit (five independent review passes; the worst findings
confirmed empirically with throwaway probe tests) produced the defect list below. This
document is the working plan to fix all of it. It is written so a fresh session can
execute it top-to-bottom without re-deriving anything.

**This file is transient.** When every task is checked off, fold anything left over into
`BACKLOG.md` and **delete this file** (the BACKLOG protocol in `CLAUDE.md` forbids
long-lived TODO files; this one is an explicitly sanctioned exception while the work is
in flight).

---

## How to work this plan (read before touching anything)

1. **Read `CLAUDE.md` first**, then `.wiki/index.md`. Follow the repo's conventions:
   biome formatting, no `dist/` commits, spec citations as `§N.M`, commit style from
   `git log` (`fix: …`, `test: …`, `docs: …`).
2. **One task = one commit.** Do them in the phase order below. Do not batch unrelated
   tasks into one commit.
3. **Test-first, always.** For every bug task: write the failing regression test first
   (in the package's existing test file, or `packages/core/tests/regressions.test.ts`
   with a short comment naming the task ID, matching the existing regression style).
   Watch it fail. Then fix. Then watch it pass.
4. **If you cannot reproduce a claimed bug** after an honest attempt (test written the
   way the repro sketch says, and it passes against unmodified source), do NOT force a
   fix. Change the task's checkbox to `[?]`, append a `> could-not-reproduce:` note under
   it explaining what you tried, and move on.
5. **Line numbers are anchors, not gospel.** They were correct at audit time; earlier
   fixes will shift them. Locate code by the described pattern, not the number.
6. **After each phase**: run the full pipeline — `pnpm typecheck && pnpm lint && pnpm test`.
   Fix anything you broke before starting the next phase.
7. **Behavior changes are spec changes.** Several fixes below alter documented behavior.
   Each task lists the docs to touch (`SPEC.md` section, `.wiki/` page, `API.md`). Update
   them in the same commit. When a fix lands that matches a `BACKLOG.md` entry, delete
   that entry (per protocol).
8. **Check off tasks in this file as you complete them** (`[ ]` → `[x]`), so the plan
   survives session boundaries.

Useful commands:

```bash
pnpm vitest run packages/core/tests/regressions.test.ts   # one file
pnpm vitest run -t "R-Q1"                                 # by test-name substring
```

---

## Phase 0 — infrastructure quick wins (do these first; they unblock everything else)

### [x] T0.1 — wiki-lint is blind on Windows (CRLF)
- **File:** `scripts/wiki-lint.ts:76`
- **Problem:** frontmatter regex is `/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/` — LF-only. On a
  CRLF checkout every page reads as "no frontmatter" (currently 47 bogus warnings), so all
  drift/staleness/citation checks are silently dead.
- **Fix:** make the regex CRLF-tolerant: `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/`.
  Also normalize `\r\n` → `\n` in the body before any line-count logic.
- **Then:** run `pnpm wiki:lint` and fix every *real* error/warning it now surfaces
  (broken covers paths, stale `last_verified`, orphans). That is part of this task.
- **Acceptance:** `pnpm wiki:lint` reports 0 "no frontmatter" warnings on Windows.

### [x] T0.2 — examples' tests never run in CI
- **Files:** root `vitest.config.ts` (include list, ~line 24), `.github/workflows/ci.yml`
- **Problem:** 9 test files under `examples/*/tests/` are excluded from root `pnpm test`;
  README advertises tested examples that nothing executes.
- **Fix:** either add `examples/*/tests/**` to the root vitest include (preferred if the
  alias setup permits), or add a CI step `pnpm --filter './examples/*' test`.
- **Acceptance:** CI log shows the example tests executing.

### [x] T0.3 — root `build` script is Unix-only
- **File:** root `package.json`
- **Problem:** `NODE_ENV=production pnpm …` fails on Windows (the maintainer's own OS).
- **Fix:** use `cross-env` (add as root devDependency) — `cross-env NODE_ENV=production …`.

### [x] T0.4 — stale BACKLOG entries for already-shipped work
- **File:** `BACKLOG.md`
- **Problem:** `[planned] form.submit(handler) lifecycle + setErrors` and
  `[planned] Standard Schema adapter` both appear to have shipped already
  (`packages/core/tests/form-submit.test.ts` exists; `isStandardSchema` / `validator` are
  exported from `packages/core/src/index.ts`; `packages/core/src/forms/standard-schema.ts`
  exists). Also `[planned] Router adapter packages — phase 0.2b` describes packages that
  shipped as `packages/router`.
- **Fix:** verify each against the code; delete entries that landed (per protocol,
  shipped items are removed).

---

## Phase 1 — query cache criticals (`packages/core/src/query/`)

### [x] T1.1 — **[CRITICAL]** plugin/remote `setData` leaks snapshots and wedges `hasPendingMutations`
- **Files:** `packages/core/src/query/entry.ts:374-391` (`Entry.setData`),
  `packages/core/src/query/client.ts:621` (`applyRemoteSetData`),
  `client.ts:699,712` (`setEntryData`), `packages/core/src/query/plugin.ts:31-54`
- **Problem:** `Entry.setData` unconditionally pushes a `SnapshotRecord` (holding a full
  copy of the previous payload) and sets `hasPendingMutations = true`; only
  `rollback()`/`finalize()` clear it. `applyRemoteSetData` and `setEntryData` **discard
  the returned Snapshot**, so every cross-tab message, entities backprop, or realtime
  patch leaks a record forever and `hasPendingMutations` reads `true` permanently.
- **Repro test (write first):** create a client + entry with data; call the client's
  remote-set path (or `query.setData` via the plugin API) once; assert
  `hasPendingMutations` returns to `false` and no snapshot record is retained (expose a
  test-only counter or assert via repeated setData + heap-proxy on the prev payload —
  simplest: assert `hasPendingMutations === false` after the call, which currently fails).
- **Fix (decision made — implement exactly this):** split "cache write" from "optimistic
  snapshot". Add an internal option to `Entry.setData`, e.g.
  `setData(updater, { track?: boolean })` defaulting `track: true`. All plugin/remote
  paths (`applyRemoteSetData`, `setEntryData`, anything reachable from
  `QueryClientPluginApi`) call with `track: false` — no snapshot record, no
  `hasPendingMutations` flip. The mutation `onMutate` path keeps `track: true`.
  Public `query.setData(...)` (the fire-and-forget TanStack idiom): also `track: false`;
  only the snapshot returned to `onMutate` is tracked. Update the `Snapshot` return type
  accordingly (public `setData` may keep returning a snapshot for back-compat, but it must
  be pre-finalized/no-op if untracked — simpler: keep returning a working snapshot ONLY
  from the onMutate path; document).
- **Docs:** SPEC §6.4 (optimistic updates) and §13.2 (plugin events); `.wiki/entities/entry.md`.
- **Acceptance:** new regression test passes; existing mutation/rollback tests still pass;
  cross-tab + entities integration tests still pass.

### [x] T1.2 — **[CRITICAL]** hydration keyed by key-hash only → cross-query data theft
- **Files:** `packages/core/src/query/types.ts:77-81` (`DehydratedEntry`),
  `client.ts:760-766` (`hydrate` buffering), `client.ts:894-895` (`bindEntry` adoption),
  `client.ts:671` (`applyDehydratedEntry`), `packages/react/src/streaming.ts` (payload shape)
- **Problem:** dehydrated entries carry no query identity. Server dehydrates query A keyed
  `['byId','1']`; a client subscriber of query B with the same key shape silently adopts
  A's payload (wrong type at runtime) and skips its fetch because `staleTime` sees fresh
  data.
- **Repro test:** two `defineQuery`s with identical `key` output; dehydrate a root where
  only A fetched; hydrate into a fresh root; subscribe B with the colliding key; assert B
  fetches its own data (currently it adopts A's).
- **Fix (decision made):** add a stable query identity to `DehydratedEntry` — use the
  `queryId` already assigned at registration (see `plugin.ts` registration); if that id is
  not stable across server/client bundle evaluation order, derive a stable one from the
  query's registration name/spec (add an optional `name` to `defineQuery` spec falling
  back to a registration counter — check how `lookupRegisteredQuery` keys things and reuse
  it). Namespace the hydration buffer map by `queryId` + key hash; `bindEntry` adoption
  must match both. Bump nothing for back-compat — SSR payloads are ephemeral
  (server/client always deploy together); note the payload shape change in the changelog.
  Update the streaming hydrator to carry and match the same identity.
- **Docs:** SPEC §15 (SSR), `.wiki/flows/ssr.md`.

---

## Phase 2 — core lifecycle criticals (`packages/core/src/controller/`, `query/use.ts`)

### [x] T2.1 — **[CRITICAL]** key change while suspended permanently bricks the subscription
- **Files:** `packages/core/src/query/use.ts:145-146` (regular), `use.ts:367-368` (infinite)
- **Problem:** the binding effect starts with `if (suspended) return` where `suspended` is
  a plain closure boolean. If a key/enabled signal changes while suspended, the effect
  re-runs, reads **no** signals, and its dependency set becomes empty — inert forever.
  `resume()` manually rebinds once (masking it), but every later key change is ignored.
  Confirmed: `ctx.use(q, () => [id.value])`; suspend → `id.set('b')` → resume →
  `id.set('c')` → fetches a, b, never c.
- **Repro test:** exactly that sequence; assert a fetch for `'c'` happens after the final set.
- **Fix (decision made):** inside the effect, **always evaluate the key function first**
  (tracked) so dependencies survive, THEN early-return on `suspended` before doing any
  binding side effects:
  ```ts
  const keyArgs = keyFn()        // tracked read — keeps deps alive while suspended
  if (suspended) return
  // …existing bind logic using keyArgs…
  ```
  Apply the identical change to the infinite-query variant. Ensure `enabled` (if read in
  the effect) is also read before the suspended check.
- **Docs:** `.wiki/flows/query-subscription.md`; add a pitfall page
  `.wiki/pitfalls/suspended-effects-lose-deps.md` describing the empty-dependency-set trap.

### [x] T2.2 — **[CRITICAL]** entries registered during `resume()` are double-activated; orphaned effect survives dispose
- **File:** `packages/core/src/controller/instance.ts:341-376` (resume loop), `:349`
  (re-activation), `:407-412` (existing guard for the suspended state)
- **Problem:** `resume()` iterates `entries.forward()`; a node pushed during traversal
  (e.g. an effect registered inside an `onResume` handler) is created **live** (state is
  already `'active'`), then the loop reaches it and runs
  `entry.dispose = standaloneEffect(entry.factory)` again — overwriting the live dispose
  ref without calling it. Confirmed: the effect runs twice per signal change and one
  instance keeps running after `root.dispose()`.
- **Repro test:** controller with `ctx.onResume(() => ctx.effect(...))`; suspend; resume;
  assert the effect fires exactly once per dependency change; dispose the root; assert it
  stops entirely.
- **Fix (decision made):** in the resume loop, before re-activating an effect entry, skip
  any entry whose `dispose` is already set (it is live — it was created during this
  resume). Alternative equally acceptable: snapshot the entry list into an array before
  iterating and only process the snapshot. Prefer the skip-if-live check (cheaper, and
  also covers effects re-registered by re-running effects).
- **Docs:** `.wiki/entities/controller-instance.md`.

### [x] T2.3 — **[MAJOR]** `ctx.collection` reconcile effect tracks user-code signal reads
- **File:** `packages/core/src/controller/instance.ts:815-899` (`reconcile`), compare the
  correct pattern at `packages/core/src/query/use.ts:161` (`untracked` around binding)
- **Problem:** `keyOf`, `propsOf`, `factory`, child `construct`, and child `dispose` all
  run inside the tracked effect scope. A child factory that reads one unrelated signal
  makes the whole collection re-reconcile on every write to it (confirmed).
- **Repro test:** collection whose item factory reads an unrelated `signal`; write to that
  signal; assert `keyOf` is NOT re-invoked / no reconcile happens (spy or counter).
- **Fix:** read the collection **source** (the tracked input) first, then wrap the entire
  diff/construct/dispose body in `untracked(() => { … })`.
- **Docs:** `.wiki/modules/controller.md`.

### [x] T2.4 — **[MAJOR]** every `ctx.*` except `effect` is unguarded after dispose
- **File:** `packages/core/src/controller/instance.ts` (only `ctx.effect` checks
  `isTerminal()`, ~line 388)
- **Problem:** `ctx.session/attach/child/use/mutation/cache/form/field/…` called after
  dispose push into a cleared `LifecycleList` — fully live children/subscriptions that
  never get torn down (confirmed for `ctx.session`). And `ctx.effect` silently no-ops —
  two different silent behaviors for the same mistake.
- **Fix (decision made — throw loudly, consistently):** every `ctx.*` factory method
  guards with `isTerminal()` and **throws**
  `new Error('[olas] ctx.<name>() called after the controller was disposed')`. Change
  `ctx.effect` from silent no-op to the same throw. Route nothing through `dispatchError`
  — a post-dispose call is a programming error, not a runtime condition.
- **Repro test:** for each guarded method: dispose root, call it, expect throw. Also
  assert no leak (e.g. `ctx.session` after dispose must not construct a child).
- **Docs:** this is a behavior change — SPEC §4 (lifecycle) gets a sentence: "calling any
  `ctx.*` factory after dispose throws"; `.wiki/entities/ctx.md`.

### [x] T2.5 — **[MAJOR]** reserved-name conflict throw leaks the constructed tree
- **File:** `packages/core/src/controller/root.ts:61-67` (try/catch covers `construct`
  only), `:88` + `:143-147` (`attachRootControls` throw site)
- **Problem:** if the controller api defines `dispose`/`suspend`/etc., `attachRootControls`
  throws AFTER construction — neither `instance.dispose()` nor `queryClient.dispose()`
  runs; focus/online/plugin listeners survive. (The identical leak for factory throws is
  already fixed and pinned at `controller.test.ts:504-525` — this is the missed second site.)
- **Fix:** widen the try/catch (or add a second one) so an `attachRootControls` throw
  disposes `instance` and `queryClient` before rethrowing.
- **Repro test:** mirror `controller.test.ts:504-525` but with an api that defines
  `dispose`; assert the tree's `onDispose` hooks ran and window listeners are gone.

### [x] T2.6 — **[MAJOR]** explicit item suspension doesn't survive a tree suspend/resume cascade
- **Files:** `packages/core/src/controller/instance.ts:355-358` (cascade resume),
  `:697-707` (`attach.resume`), `packages/core/src/controller/types.ts:110-116`
  (`suspendItem` contract)
- **Problem:** `Collection.suspendItem` promises reconcile won't auto-resume, but a
  whole-tree `suspend()` → `resume()` (exactly what KeepAlive does) wakes every child —
  a virtualized list's scrolled-out rows all resume. Conversely `attach.resume()` happily
  resumes a child under a still-suspended parent.
- **Fix (decision made):** add an `explicitlySuspended: boolean` flag on the child
  lifecycle entry, set by `suspendItem` / `attach.suspend()`, cleared by
  `resumeItem` / `attach.resume()`. The tree resume cascade skips entries with the flag.
  `attach.resume()` under a suspended parent: clear the flag but do NOT activate; record
  that the child should resume when the parent resumes (i.e. it simply participates in the
  parent's next cascade).
- **Repro tests:** (a) suspendItem → tree suspend → tree resume → item still suspended;
  (b) attach.suspend → tree cycle → still suspended; (c) attach.resume under suspended
  parent → child stays inactive until parent resumes, then activates.
- **Docs:** SPEC §4; `.wiki/entities/controller-instance.md`.

### [x] T2.7 — **[MAJOR]** `debounced`/`throttled` leak subscriptions; assorted timing bugs
- **Files:** `packages/core/src/timing/debounced.ts:59,113`, `throttled.ts:51,64-77`
- **Problems:** (a) the internal `effect` subscribes to `source` forever — no `dispose` on
  the returned handle, no ctx ownership; (b) the handle is a writable `Signal` typecast to
  `TimingSignal`; (c) `throttled` with `trailing: false` schedules useless timers and
  leaves `hasPending` set, so a later `flush()` emits a value the option said never should;
  (d) `debounced` with `leading: false, trailing: false` never emits — no validation.
- **Fix:** add `dispose()` to the `TimingSignal` handle (tears down the internal effect and
  timers); wrap the returned signal with the existing `readOnly()` helper
  (`signals/readonly.ts`) merged with the handle methods; in `throttled`, don't schedule a
  trailing timer when `trailing: false` and never set `hasPending`; throw on
  `{leading: false, trailing: false}`.
- **Tests:** the leading/trailing options matrix currently has ZERO core coverage
  (`timing.test.ts` covers defaults + abort only) — add the matrix: leading-only,
  trailing-only, both, flush/cancel for each.
- **Docs:** `.wiki/modules/timing.md`; API.md timing section.

### [x] T2.8 — minor core batch (one commit, several small fixes)
- [x] Emitter docstring lies: `emitter.ts:4` claims handlers removed during emit are
  skipped; code iterates a snapshot (`:41-44`) and the test pins the opposite
  (`emitter.test.ts:93-96`). **Fix the docstring** to match the pinned behavior. Also
  document the `Set`-dedupe behavior (`on(h); on(h)` registers once) in the same docstring.
- [x] Type-only immutability: `collection.items`/`size` (`instance.ts:754-755, 902-903`)
  and `lazyChild.status/api/error` (`:930-932, 1028-1031`) are writable `Signal`s typed as
  `ReadSignal`. Wrap with `readOnly()` (pattern at `selection.ts:173`).
- [x] Construction-rollback swallows teardown errors: `instance.ts:240-242` bare
  `catch {}` — route through `dispatchError` like `dispose()` does (`:255-260`).
- [x] Effect **cleanup** throws bypass `onError`: `instance.ts:395-405` guards the body
  only. Wrap the returned cleanup: if the factory returns a function, return a wrapper
  that try/catches and routes to `dispatchError`.
- [x] `Root<Api>` lies for non-object apis (`root.ts:69-88`): constrain
  `createRoot<Api extends object>` at the type level; keep the runtime wrap for JS callers.
- [?] Devtools `pathKey` joins with `' '` (`devtools.ts:76-78`) — controller names can
  contain spaces → collisions. Join with `' '`.
  > could-not-reproduce: `pathKey` already joins with `\0` (a NUL byte), not a space —
  > the audit (and most editors) render a NUL as blank, so it *looked* like a space.
  > `od -c` on `devtools.ts:77` confirms `path.join('\0')`. A NUL can't appear in a
  > controller name/segment, so the separator is already unambiguous. No change made.

---

## Phase 3 — query cache majors (`packages/core/src/query/`)

### [x] T3.1 — **[MAJOR]** out-of-order rollback of parallel optimistic mutations corrupts data
- **File:** `packages/core/src/query/entry.ts:394-403` (rollback restores `record.prev` blindly)
- **Problem (confirmed):** data 0 → mutation A applies +1 → B applies +10 → data 11.
  A fails first (rollback → 0), then B fails (rollback → **1**, resurrecting A's delta).
  Correct final state is 0. Only LIFO order is tested (`mutation.test.ts:362-409`).
- **Fix (decision made — chain-splice, not full rebase):** when rolling back a record that
  is NOT the top of the stack, do not touch current data; instead splice the chain:
  `records[i+1].prev = records[i].prev`, then drop record i. Rolling back the top record
  restores its `prev` as today. This guarantees the final state after all rollbacks equals
  the original pre-mutation value (fixes the confirmed corruption). Full updater-replay
  rebasing is out of scope — add a `BACKLOG.md` entry for it.
- **Repro test:** the 0/+1/+10 scenario with A failing first; assert final data is 0.
  Keep the existing LIFO test green.
- **Docs:** SPEC §6.4 — describe the chain-splice semantics honestly ("non-top rollback
  removes that layer's baseline from the chain; current data is only rewritten when the
  top layer rolls back").

### [x] T3.2 — **[MAJOR]** `refetchInterval` livelocks when fetch duration > interval
- **Files:** `client.ts:146-158` (interval tick), `entry.ts:148-151` (startFetch aborts in-flight)
- **Problem (confirmed):** each tick aborts the in-flight fetch — 11 starts, 0 completions
  over 10 simulated seconds; data forever `undefined`; request-per-interval hammering.
- **Fix:** the interval tick joins instead of aborts: `if (entry.isFetching.peek()) return`.
- **Repro test:** fake timers; fetch resolving in 2500ms, `refetchInterval: 1000`; advance
  10s; assert ≥1 completion and data set.

### [x] T3.3 — **[MAJOR]** infinite query status wedges at `'pending'`
- **Files:** `packages/core/src/query/infinite.ts:281-284` (fetchNextPage supersedes
  background refetch), `:294-304` (next-page success doesn't restore status), `:396-408`
  (superseded finally resets direction flags only)
- **Problem (confirmed):** invalidate → user pages while revalidating → `status:'pending'`,
  `isFetching:false`, data present; Suspense waiters hang until some future full refetch.
- **Fix:** make status transitions owned by the current fetch id: when a fetch is
  superseded, the superseder is responsible for the final status; on any successful page
  operation (`fetchNextPage`/`fetchPreviousPage`/full refetch) set `status: 'success'`;
  in the superseded path's finally, if no newer fetch is running and data exists, restore
  `'success'`.
- **Repro test:** the exact interleaving above with deferred promises; assert
  `status === 'success'` and `firstValue()` resolves.

### [x] T3.4 — **[MAJOR]** no cancellation API; in-flight fetch clobbers optimistic writes
- **Files:** `packages/core/src/query/types.ts:188-198` (`Query` surface), `client.ts`,
  `entry.ts`
- **Problem (confirmed):** refetch in flight → `setData(999)` → stale response lands →
  data reverts. The canonical optimistic recipe (cancel outgoing refetches, then setData)
  is unwritable — there is no `cancel`.
- **Fix (two parts):**
  1. Add `query.cancel(...keyArgs)` (and a client-level `cancelAll(query?)`): aborts the
     entry's in-flight fetch via the existing abort plumbing, restores status to
     `'success'` if data exists else `'idle'`, does not touch data. Mirror onto
     `QuerySubscription` as `subscription.cancel()`.
  2. On fetch success (`applySuccess`), rebase any live snapshot records:
     `record.prev = freshData` for all records in the stack (server truth supersedes
     pre-mutation baselines), so a later auto/user rollback can no longer resurrect
     pre-refetch data.
- **Tests:** (a) cancel mid-fetch → no data write, status restored, no unhandled
  rejection; (b) setData-during-fetch + cancel → optimistic value survives; (c) fetch
  success then mutation failure rollback → data stays at server truth, not pre-mutation.
- **Docs:** SPEC §5 (queries) + §6.4; API.md; README optimistic-update recipe gains the
  cancel step.

### [x] T3.5 — **[MAJOR]** `networkMode: 'offlineFirst'` is documented but not implemented
- **Files:** `types.ts:130-134` (the promise), `entry.ts:143-147, 209-234` (no such code)
- **Problem:** `offlineFirst` behaves identically to `always`. Also offline-deferred
  fetches sit at `status:'idle'` with nothing telling the UI they're waiting for network.
- **Fix:** implement the documented behavior: in the fetch catch path, if
  `networkMode === 'offlineFirst'` and `navigator.onLine === false` and the error is
  network-shaped (fetch TypeError / AbortError excluded), reset the entry to idle and
  register a one-shot resume with the existing online-listener infrastructure
  (`focus-online.ts`). Add `isPaused: ReadSignal<boolean>` to `AsyncState` that is true
  while a fetch is deferred/parked waiting for reconnect (both the initial offline-defer
  path and the offlineFirst park path).
- **Tests:** simulate offline (stub `navigator.onLine` + dispatch `online` event);
  assert park → resume-on-reconnect → success; assert `isPaused` transitions.
- **Docs:** SPEC §5.x networkMode; API.md `AsyncState` table (new signal); `.wiki/modules/query.md`.

### [x] T3.6 — **[MAJOR]** rollback/finalize emit no plugin events (cross-tab peers keep failed optimistic state)
- **Files:** `entry.ts:394-403` (rollback writes data directly), `client.ts:1026` (the
  emit path used by normal setData)
- **Fix:** route the rollback data write through the same `emitSetData` path with
  `source: 'set'`, `isRemote: false`, so cross-tab re-broadcasts the restored value.
  Verify the entities plugin handles the event idempotently (it should — it's just
  another set).
- **Test:** plugin spy asserts a SetDataEvent fires on rollback with the restored payload.

### [x] T3.7 — **[MAJOR]** infinite queries: interval refetch truncates pages; invisible to SSR
> part 1 (refetch-all-pages) implemented — `InfiniteEntry.runRefetchAll` replaces
> the collapse-to-page-one refetch; SPEC updated (silent → refetch-all for all
> paths, TanStack-aligned). part 2 (infinite SSR dehydrate) deferred per plan:
> BACKLOG entry added + limitation documented in SPEC §15 and packages/react README.
- **Files:** `infinite.ts:219, 246-252` (invalidate collapses to page one),
  `client.ts:308-318` (interval on infinite), `client.ts:809-823` (dehydrate skips
  infinite), `packages/react/src/streaming.ts:114`, `client.ts:236-276`
- **Fix now (part 1):** background/interval-driven refetch of an infinite entry must
  refetch all currently-loaded pages sequentially (TanStack behavior) instead of
  collapsing to page one. Explicit user `invalidate()` may keep collapse semantics if
  that's what SPEC says — check SPEC §5.7 and align; if SPEC is silent, refetch-all-pages
  for both and update SPEC.
- **Defer (part 2):** infinite-query dehydrate/hydrate (SSR) is a feature, not a bug fix.
  Add a `BACKLOG.md` entry: "infinite queries are not dehydrated; server-rendered
  infinite lists refetch on client" and document the limitation in SPEC §15 and
  `packages/react` README.
- **Test (part 1):** load 3 pages; trigger interval refetch; assert 3 pages retained and
  refetched, no truncation flash.

### [x] T3.8 — **[MAJOR]** `stableHash` Date/class handling is dead code
- **File:** `packages/core/src/query/keys.ts:34, 42-47`
- **Problem (confirmed):** `JSON.stringify` applies `toJSON` BEFORE the replacer, so the
  `__date` tag never fires — `stableHash([date]) === stableHash([date.toISOString()])`,
  the exact documented collision. Class instances with `toJSON` bypass the documented throw.
- **Fix:** in the replacer, use `this[key]` (the holder object's raw property — replacer
  functions receive the pre-`toJSON` value there): `const raw = (this as any)[key];
  if (raw instanceof Date) return ['__date', raw.toISOString()]; …` and do the
  class-instance check on `raw` too.
- **Test:** `stableHash([new Date(0)]) !== stableHash(['1970-01-01T00:00:00.000Z'])`;
  class-with-toJSON still throws.

### [ ] T3.9 — query minor batch (split into 2–3 commits as sensible)
- [ ] `onMutate` throw is swallowed and the mutation still runs (`mutation.ts:295-303`) —
  abort the mutation instead: route the error to `onError`/reject the run promise, do not
  call `mutate`.
- [ ] `subscription.refetch()` rejects with `AbortError` on supersede (`use.ts:85-89`) —
  never reject on supersede; resolve with the superseding fetch's outcome or resolve void.
- [ ] Focus double-fire: `focus` + `visibilitychange` both trigger
  (`focus-online.ts:44-52`) and `triggerEventRefetch` doesn't check `isFetching`
  (`client.ts:206-211`) — add the isFetching join (T3.2's helper) and debounce the two
  events into one (e.g. microtask flag).
- [ ] `invalidate()` on subscriber-less cached entries fetches immediately
  (`entry.ts:357-364`) — mark stale only; fetch on next subscribe (TanStack semantics).
  Check SPEC §5 wording and update.
- [ ] Streaming `flush()` unguarded `JSON.stringify` (`streaming.ts:144`) — try/catch;
  on failure dev-warn + skip that entry rather than corrupting the stream.
- [ ] `waitForIdle` hangs if racing dispose — disposed entries keep `isFetching: true`
  (`entry.ts:454-479`) — reset `isFetching` to false in entry dispose.
- [ ] Default retry has no backoff (`entry.ts:101-102`) — keep `retry: 0` default, but
  when `retry > 0` and no `retryDelay` given, default to exponential:
  `min(1000 * 2 ** attempt, 30_000)`.
- [ ] Duplicate `queryId` registration replaces silently (`plugin.ts:215-217`) —
  dev-warn.
- [ ] `_unregisterMutationById` is documented "not exported" but exported
  (`plugin.ts:279-280` vs `index.ts:88`) — remove from the public entry; move to
  `testing.ts` if tests need it.
- [ ] Dual-package hazard: `mutationRegistry` is a module-level `Map`
  (`plugin.ts:261`) — key it on `globalThis` under a `Symbol.for('olas.mutationRegistry')`
  so ESM+CJS copies share it.

---

## Phase 4 — React adapter (`packages/react/src/`)

### [ ] T4.1 — **[CRITICAL]** `HydrationBoundary` builds a root in `useMemo`: leaks, StrictMode double-root, no dispose
- **File:** `packages/react/src/context.ts:154` (+ docstring `:114-117`, intake effect `:158-161`)
- **Problem:** `createRoot` (side-effectful: fetches, timers, listeners) runs in a
  `useMemo` keyed `[def, options]`. StrictMode double-invokes → orphaned live root. No
  unmount disposal. Inline `options` literal (as shown in its own docstring!) recreates
  the root on every parent re-render, silently discarding all state. Zero tests render it.
- **Fix (decision made — ref + effect ownership):**
  ```
  - keep the root in a ref; create lazily during render if ref.current === null
  - options: capture the FIRST options object in a ref; ignore identity changes
    (document: "options is read once on mount")
  - recreate only when `def` identity changes (dispose old, create new)
  - useEffect cleanup: dispose the root and null the ref (StrictMode's
    mount→cleanup→remount then creates a fresh root; double-fetch in dev is acceptable
    and is what TanStack does)
  ```
- **Tests (new file `packages/react/tests/hydration-boundary.test.tsx`):** (a) unmount
  disposes the root (spy on a controller `onDispose`); (b) `<StrictMode>` mount leaves
  exactly ONE live root; (c) parent re-render with inline options does NOT recreate the
  root; (d) `def` change disposes old and creates new.
- **Docs:** fix the docstring example; API.md HydrationBoundary section (add it — see T6.4).

### [ ] T4.2 — **[MAJOR]** `useMutation().isSuccess` never true for `void` mutations
- **Files:** `packages/react/src/hooks.ts:481-495`;
  `packages/core/src/query/mutation.ts:150-192` (no status signal)
- **Problem (confirmed by inspection):** `isSuccess` derives from
  `mutation.data.peek() !== undefined`; `ctx.mutation<Args, void>` (the most common shape,
  used in the integration test itself) resolves `undefined` → `isSuccess` false forever,
  `isIdle` true.
- **Fix:** add `status: ReadSignal<'idle' | 'pending' | 'success' | 'error'>` to core
  `Mutation` (set in run/success/error/reset paths; `latest-wins` supersede goes back to
  the superseder's pending). Derive `isSuccess`/`isIdle`/`isError` in `useMutation` from
  `status`, not from data.
- **Tests:** core: status transitions for all three concurrency modes incl. supersede;
  react: void mutation → `isSuccess === true` after resolve.
- **Docs:** SPEC §6 mutation surface; API.md.

### [ ] T4.3 — **[MAJOR]** `useSuspenseQuery` throws on background-refetch failure while data exists
- **File:** `packages/react/src/hooks.ts:177-180` (`:183` claims TanStack parity)
- **Problem:** `Entry.applyFailure` keeps `data` (`entry.ts:277-283`), but the hook throws
  whenever `status === 'error'` — a focus-refetch blip nukes a rendered subtree to the
  ErrorBoundary. TanStack suspense throws only when there's no data.
- **Fix:** `if (status === 'error' && data === undefined) throw error;` — otherwise return
  the (stale) data. The error remains observable via `useQuery`'s non-suspense fields.
- **Test:** first load succeeds → refetch fails → component keeps rendering data, boundary
  NOT hit (existing suspense test covers only the initial-error path).

### [ ] T4.4 — **[MAJOR]** `use(signal, { select })` returns stale slice when selector changes
- **File:** `packages/react/src/hooks.ts:72-86`
- **Problem:** snapshot cache invalidates only on `!Object.is(last.raw, raw)`. When
  `select` changes (e.g. `s => s.items[props.index]` with a new index) but the raw signal
  value doesn't, the hook returns the OLD selector's result.
- **Fix:** store the selector reference in `lastRef`; recompute when `last.select !== select`
  OR raw changed. (Same for `isEqual` if cached.)
- **Test:** signal holding an array; render with `select` for index 0, re-render with index
  1 → assert new slice. Add a basic `isEqual` test too — the option currently has zero coverage.

### [ ] T4.5 — **[MAJOR]** version-counter snapshots defeat `useSyncExternalStore` consistency
- **File:** `packages/react/src/hooks.ts:147-172` (useQuery), `:249-272` (useField),
  `:348-368` (useFieldInput), `:438-461` (useMutation)
- **Problem:** `getSnapshot = () => versionRef.current` where the version bumps only
  inside the subscribe callback. A write landing between render and subscription doesn't
  bump anything — uSES's mount consistency re-check passes vacuously and the component
  shows stale peeked values until the next write. Initial-mount tearing is undetectable
  for the same reason.
- **Fix (decision made):** replace the version counter with a **memoized computed
  snapshot**: per subscription target, create (in `useMemo` keyed on the target) a core
  `computed(() => ({ …peek/read all relevant signals… }))`; `getSnapshot` returns
  `computedSnapshot.value` (a stable object identity that changes exactly when any dep
  changes); subscribe via the existing `subscribeChanges` on that computed. This makes the
  snapshot reflect actual store state so uSES's consistency check works.
- **Tests:** hard to pin timing-wise — at minimum assert existing behavior still passes
  and add one test: render component reading a field, synchronously write the field from
  outside React after render but before effects (e.g. in a layout-effect of a sibling
  rendered later), assert the final paint shows the new value.

### [ ] T4.6 — **[MAJOR]** `SuspendOnUnmount`/KeepAlive has no refcounting; overlap ordering ends wrong
- **File:** `packages/react/src/keep-alive.ts:23-35` (docstring `:17-22` admits the problem)
- **Problem:** during cross-fades the exiting screen's `suspend()` runs AFTER the entering
  screen's `resume()` → controller suspended while visibly mounted. Also first paint after
  remount happens before the effect's `resume()`.
- **Fix (decision made):** refcount. Keep a `Map<handle, count>` (module-level WeakMap
  keyed by the controller handle). Mount: increment; if 0→1, `resume()`. Unmount:
  decrement; if 1→0, `suspend()`. Use `useLayoutEffect` (not `useEffect`) so resume runs
  before paint. Overlapping mount/unmount now nets to count=1 → stays resumed regardless
  of ordering.
- **Test:** simulate cross-fade (render B, then unmount A in the same commit or after);
  assert final state is resumed. Two consumers of the same handle: unmounting one keeps it
  resumed.

### [ ] T4.7 — React minor batch
- [ ] `aria-errormessage` gets error TEXT (`hooks.ts:398`) — per ARIA it takes an element
  ID reference. Remove it from `useFieldInput`'s props (keep `aria-invalid`); document
  that consumers should wire `aria-describedby` themselves.
- [ ] `useFieldInput` handler memo keyed on `[field, transform]` while the docstring shows
  an inline `transform` literal — keep the latest transform in a ref, memo handlers on
  `[field]` only.
- [ ] Docstring at `hooks.ts:106` says `subscription.reset()` re-suspends — false
  (`Entry.reset` at `entry.ts:366-372` sets `'success'` when data exists). Fix the doc.
- [ ] `useSuspenseQuery` + disabled/idle query suspends forever (`hooks.ts:184-186`) —
  throw a descriptive dev error if the subscription is disabled (mirror TanStack's
  "suspense requires enabled" stance).
- [ ] Streaming docstring wires the plugin to the wrong root (`streaming.ts:165-173`) —
  the example creates a plugin'd root then lets `HydrationBoundary` create ANOTHER root.
  Rewrite the example to pass the plugin through HydrationBoundary's options.
- [ ] Teardown intake drops late entries (`streaming.ts:257-261`, `push: () => {}`) —
  queue them (re-install the bootstrap queue) instead of dropping.
- [ ] `options as any` at `context.ts:154` — type it properly with `RootOptions<…>`.

---

## Phase 5 — forms (`packages/core/src/forms/`)

### [ ] T5.1 — **[CRITICAL]** structural FieldArray edits invisible to `isDirty` → background refetch destroys user rows
- **Files:** `packages/core/src/forms/form.ts:707-717` (array isDirty), `:104-126` +
  `:120` (reactive initial + when-clean guard), `:227-241` (asInitial clear+re-add)
- **Problem:** `FieldArray.isDirty` = "any item dirty". `add()`/`remove()`/`move()` leave
  it false. With `initial: () => queryData` and the default
  `resetOnInitialChange: 'when-clean'`, a background refetch re-seats the array and
  **silently deletes rows the user just added**. This is the worst user-facing bug in the
  library.
- **Fix (decision made):** track structural dirtiness explicitly. FieldArray keeps a
  `structurallyDirty = signal(false)`, set true by `add`/`remove`/`move`/`clear`
  (any user-driven structural op), reset to false by `reset()` and by an
  initial-driven re-seat (`applyPartial` asInitial path). `isDirty` becomes
  `structurallyDirty || anyItemDirty`. The when-clean guard then correctly refuses to
  re-seat after structural edits.
- **Tests:** (a) add a row → `form.isDirty === true`; (b) reactive-initial form,
  user adds a row, initial signal changes → array NOT re-seated, user row survives;
  (c) `reset()` clears structural dirt; (d) remove/move also flip it.
- **Docs:** SPEC §8 dirty semantics; `.wiki/modules/forms.md`.

### [ ] T5.2 — **[MAJOR]** cross-field validation cannot target fields; Standard Schema issues lose paths
- **Files:** `form.ts:489-546` (top-level errors), `validators.ts:16-30` (Standard Schema
  wrapper keeps only first issue's message, drops `issue.path`), existing plumbing:
  `form.setErrors(pathMap)` + `resolvePath` at `form.ts:416-426`
- **Problem:** a form-level validator returns one `string | null` → "passwords must match"
  cannot appear on the confirm field; a whole-form Zod schema collapses to one anonymous
  top-level string.
- **Fix (decision made):** extend the form-level validator return type to
  `string | null | FormIssue[]` where
  `type FormIssue = { path: (string | number)[]; message: string }`.
  Issues with a non-empty path route to the matching field/array/form node into a NEW
  per-field `formErrors` signal (a third channel beside validator errors and server
  errors), merged into the field's visible `errors`, cleared on the next form-level
  validation run. Empty-path issues go to `topLevelErrors` as today. Rewrite the Standard
  Schema wrapper to return ALL issues as `FormIssue[]` (mapping `issue.path` segments).
- **Tests:** password/confirm matcher lands on the confirm field; Zod object schema with
  two field errors → both fields show their message; issues clear when fixed.
- **Docs:** SPEC §8 validators; API.md; `.wiki/modules/forms.md`, `.wiki/modules/zod.md`.

### [ ] T5.3 — forms minor batch
- [ ] `validateOn: 'blur' | 'submit'` has ZERO tests (grep confirms). Write them:
  blur-locked field doesn't validate on change, validates on `markTouched`;
  submit-locked validates only on `form.validate()`; interaction with `reset()`
  re-locking and `revalidate()` force-unlock (`field.ts:125-131, 149-151, 272-294, 350-359`).
- [ ] `dirtyFields` and `clearSubtree` untested — add coverage.
- [ ] `required()` rejects `false` (`validators.ts:40-41`) — wrong for genuine booleans.
  Change: `false` passes `required`; add `mustBeTrue(message?)` validator for
  confirm-checkboxes. Update any tests/docs relying on the old behavior; SPEC §8 note.
- [ ] `isValid === false` while `isValidating` (`field.ts:159`) — with `debouncedValidator`
  the submit button strobes. Keep last-known validity while a validation is in flight
  (only flip on completion).
- [ ] `Form.reset()` re-applies initial outside the batch (`form.ts:296-301`) — move
  inside the batch.
- [ ] Thrown-validator `err.message` lands in user-visible errors (`field.ts:391`) — keep
  fail-loud, but in prod builds replace with a generic "Validation failed" and route the
  real error to `dispatchError` (dev keeps the message).

---

## Phase 6 — satellite packages

### [ ] T6.1 — persist: IDB adapter acks before commit; error routing is dead
- **File:** `packages/persist/src/index.ts`
- [ ] `runRequest` resolves on `req.onsuccess` (`:187-193`) — quota failures surface at
  COMMIT. Resolve `set`/`delete` on `tx.oncomplete`, reject on `tx.onabort`/`onerror`.
- [ ] The adapter swallows every error internally and resolves (`:199-224`) — so
  `usePersisted`'s `onError` never fires for IDB. Reject instead; let `usePersisted`'s
  existing error routing do its job.
- [ ] `flushWrite` labels a storage `QuotaExceededError` as op `'serialize'` (`:451-457`)
  — split the try blocks: encode → `'serialize'`, storage.set → `'write'`.
- [ ] Ready-gate races: writes before load resolve are dropped then clobbered by
  `applyLoaded` (`:410-416, :484`) — if the user wrote before load resolved, SKIP
  applyLoaded (user wins) and flush the pending write. Cross-tab `onChange` never checks
  `ready` (`:491-529`) — buffer remote changes until ready, then apply the freshest.
- [ ] No `onversionchange` handler (`:159-179`) — close the connection, mark the adapter
  broken, surface via `onError('load'|'write')` instead of permanent silent no-ops.
- [ ] **Zero tests exist for `version`/`migrate`/`throttleMs`/`onError`** — write them
  (envelope parse, legacy payload migration, remote-change version gating, quota error path).

### [ ] T6.2 — mutation-queue: fix the three disqualifiers, demote the claims
- **File:** `packages/mutation-queue/src/plugin.ts`
- [ ] **Replay only at init** (`:508-514`) — add an `online` event listener (via the same
  focus-online util or `window.addEventListener('online')`) that triggers `replayAll`;
  also expose `api.replayNow()` for manual triggering. In-session failures must retry on
  reconnect, not on reload.
- [ ] **No multi-tab coordination** — wrap `replayAll` in a Web Locks request
  (`navigator.locks.request('olas-mq:' + keyPrefix, …)`); when Web Locks is unavailable,
  fall back to a localStorage lease (timestamped, TTL ~30s, re-checked before each entry).
  Two tabs must never replay the same entry concurrently.
- [ ] **No cache reconciliation after replay** (`:350` calls raw `mutate` only) — add a
  plugin option `onReplaySettle(entry, result, api)` (with `api.invalidate(query, key)`
  reachable via the registered-query lookup) so apps can invalidate affected queries;
  document prominently that without it, UIs stay stale after replay.
- [ ] `seq` priming race (`:473-475` vs `:530`) — prime `seq` BEFORE enabling enqueue
  (block enqueue on the priming promise, or namespace seq as
  `${Date.now()}:${counter}` — Date.now is allowed in package code, only workflow scripts
  forbid it).
- [ ] `activeKeys` cleared on `'cancelled'` settle (`:549-555`) contradicting the
  documented contract (`:153-156`) — honor the contract; add a test for
  cancel + re-enqueue not double-writing durable entries.
- [ ] **Untested option surface** — `dedupeBy`, `ttlMs`, `backoffMs`, `onReplayAttempt`,
  `migrate`, `maxEntryBytes`, `waitForOnline`, seq ordering: write a test for each
  (grep confirms zero references today).
- [ ] `void writeEntry(entry)` fire-and-forget (`:544`) over an adapter that acks before
  commit — after T6.1's commit-ack fix, await the write before reporting enqueued (or
  document the small loss window explicitly).
- [ ] **README/package description demotion:** until ALL of the above ship, the package
  must describe itself as "best-effort persist + reload replay", not "durable". After they
  ship, re-review the wording. Cross-mutation causal ordering (parallel replay across
  mutationIds, `:477-504`) stays a documented limitation — add a BACKLOG entry.

### [ ] T6.3 — devtools: false `[Circular]` rendering; unbounded tree growth
- **Files:** `packages/devtools/src/JsonView.tsx:57-62`, `src/store.ts:211-217, 250,
  335-351, 407-409, 447-481`, `src/DevtoolsPanel.tsx:260-358, 424-426`
- [ ] `JsonView` cycle guard uses a shared `WeakSet` populated during render and never
  cleared — collapse→re-expand shows `[Circular]` for real data; under `<StrictMode>`
  EVERYTHING renders `[Circular]`. Fix: build the seen-set per render pass (local to the
  render function / passed down through recursion), never module/instance state.
  Test with StrictMode.
- [ ] Disposed controllers accumulate forever — prune disposed subtrees beyond a cap
  (default ~200 retained, configurable).
- [ ] Mutation durations pair `run`→`success` by `path#name` — include a runId in the
  pairing key so concurrent runs don't overwrite timestamps.
- [ ] Debounce the inspector filter input (it `JSON.stringify`s every cache payload per
  keystroke on top of the 800ms poll).

### [ ] T6.4 — cross-tab: dead config + receive-side hygiene
- **Files:** `packages/cross-tab/src/plugin.ts:139-154, 219-223, 240-241`;
  core `client.ts:612, 719` (receive path drops infinite payloads)
- [ ] `crossTab: 'infinite' | 'both'` broadcasts payloads NO peer can apply (core's
  `applyRemoteSetData`/`applyRemoteInvalidate` early-return for non-`'query'` defs).
  Decision: **remove the `'infinite' | 'both'` option values** (type-level) and dev-warn
  if passed; add a BACKLOG entry for infinite-query cross-tab support. Do not silently
  no-op.
- [ ] Apply the `shouldBroadcast` filter on RECEIVE as well as send, so a tab ignores
  messages for queries it wouldn't broadcast.
- [ ] Document (README) the conflict model honestly: last-delivery-wins per tab, no
  arbitration; simultaneous writes in two tabs can diverge permanently. Recommend
  server-refetch (invalidate) for authoritative sync.

### [ ] T6.5 — zod: abort-race unhandled rejection + dual-copy hazard
- **File:** `packages/zod/src/index.ts`
- [ ] `zodValidatorAsync`'s `abortPromise` (`:34-39`) rejects after `safeParseAsync`
  already won → unhandled rejection + listener never removed. Attach a no-op `.catch`
  to the loser and remove the abort listener in a `finally`.
- [ ] All introspection is `instanceof`-based (`:93-135, 260-271`) — a duplicated zod copy
  silently degrades nested objects to flat Fields. Add a dev-time warning: if a schema
  fails every `instanceof` check but has a `def`/`_def` marker, warn "duplicate zod copies
  detected — formFromZod cannot introspect this schema".
- [ ] Fix the stale "stable across 3.x and 4.x" comment (`:94-96`) — peer is `^4.0.0`;
  the comment is drift.
- [ ] `defaultInitial` gaps: `.transform()` (ZodPipe) should introspect the INPUT schema;
  `ZodDate` currently yields `null` into a `Date`-typed field — use `undefined` and widen
  the field type, or document. Add cases for coerce/unions falling back to `undefined`
  explicitly (tests).

### [ ] T6.6 — router: SSR hole + first-paint emptiness
- **File:** `packages/router/src/adapter.tsx:80-91, 94, 104-112`
- [ ] `createRouterAdapter()` accepts no initial state and the Bridge pushes route state in
  `useEffect` (never on server) — route-scoped signals are `{}`/`''` for the whole server
  render, contradicting the SSR story. Fix: `createRouterAdapter(initial?: RouteState)`
  so server code seeds params/search/pathname before rendering; document the server usage
  in the README.
- [ ] Switch the Bridge's push from `useEffect` to `useLayoutEffect` (shrinks the client
  first-paint gap); document the remaining first-render-empty footgun and the
  `enabled: () => params.value.id !== undefined` guard pattern in the README.
- [ ] Widen `params` to `Record<string, string | undefined>` (matches React Router; kills
  the internal cast at `:94`).

### [ ] T6.7 — realtime: small honesty fixes
- **File:** `packages/realtime/src/index.ts`
- [ ] `useRealtimeConnection` returns `'connected'` when the transport lacks
  `onConnectionChange` (`:310-318`) — return `'unknown'` (add to the union) instead of a
  lie-shaped default.
- [ ] Clarify the pause docs (`:140-148`): events arriving DURING pause are lost (the
  buffer preserves only already-received events); recommend `onReconnect` + invalidate
  for gap recovery.

---

## Phase 7 — delivery, docs, release

### [ ] T7.1 — un-wedge the release pipeline (do this only after Phases 1–5 land)
- npm is frozen at **0.0.6** (published 2026-05-21) while the repo is at 0.0.15 — two
  explicit correctness-pass releases never shipped. Changesets was abandoned after 0.0.6:
  no changelogs, no git tags for nine versions.
- [ ] Back-fill `CHANGELOG.md` for 0.0.7–0.0.15 per package (summarize from
  `git log --oneline`), fix the stale `# @olas/core` / `# @olas/react` headers to the
  `@kontsedal/*` names.
- [ ] Create a changeset for the remediation release; version + tag via changesets from
  now on.
- [ ] Add a CI publish job (changesets/action on main, `NPM_TOKEN` secret) so releases
  can't silently lapse again.
- [ ] Publish. **Note:** many fixes above change behavior; under the project's 0.x
  convention that's still a patch/minor bump, but write an honest combined changelog.

### [ ] T7.2 — verify what you ship
- [ ] Add `publint` and `@arethetypeswrong/cli` for every package to CI (after `pnpm build`).
- [ ] Add a dist smoke test: a small script that `import`s (ESM) and `require`s (CJS) each
  built package and touches one export; run in CI after build.
- [ ] `packages/core/tests/dev-flag.test.ts` tests the vitest define, not the shipped
  artifact — after the build step in CI, grep the built `dist/*.mjs` for a `__DEV__`
  leftover (should be none in the production build).
- [ ] Add `engines: { node: ">=18" }` to every published package.json.
- [ ] Add coverage thresholds to `vitest.config.ts` (start at current levels, ratchet up)
  and run coverage in CI.

### [ ] T7.3 — documentation debt
- [ ] **API.md is frozen at the ~0.0.4 surface.** Add: `@kontsedal/olas-mutation-queue`,
  `@kontsedal/olas-router`, `ctx.session` / `ctx.collection` / `ctx.lazyChild`
  (`core/src/controller/types.ts:295-335`), `useQuery`'s suspense option,
  `HydrationBoundary`, streaming SSR, `indexedDbAdapter` — plus everything added by this
  plan (`Mutation.status`, `query.cancel`, `isPaused`, `FormIssue`, `mustBeTrue`,
  `TimingSignal.dispose`).
- [ ] README fixes: the package-table links use Windows backslashes
  (`README.md` ~lines 465-475, `packages\core` → `packages/core`); the "React adapter is
  ~230 lines" claim is stale by >4× — remove the number or update it.
- [ ] `packages/realtime/package.json` description says `defineLiveStream`; the export is
  `useLiveStream`. `packages/persist` description omits `indexedDbAdapter`. Fix both.
- [ ] `packages/core/tests/regressions.test.ts:3` cites a nonexistent `ASSESSMENT.md` —
  point it at real history (this file's audit or the commit).
- [ ] `packages/core/tests/query.test.ts:10-14` still uses the raw triple
  `Promise.resolve()` flush the repo's own convention calls fragile — convert to
  `vi.waitFor` per the established pattern.
- [ ] Wiki ingest for everything this plan changed: update affected pages'
  `last_verified`, add the new pitfall page (T2.1), append a `log.md` entry per the
  CLAUDE.md ingest protocol.

---

## Phase 8 — devtools overhaul: from "a panel that exists" to the reason people pick Olas

**Why this phase exists.** Today the panel is a polling JSON viewer with a broken cycle
guard: it re-reads the whole cache every 800ms, re-stringifies payloads per keystroke,
never prunes disposed controllers, renders `[Circular]` for real data under StrictMode,
and offers zero actions — you can look (at possibly wrong data), but you cannot *do*
anything. T6.3 fixes the outright bugs; this phase makes the tool worth opening.

**North star.** Olas owns the whole vertical — signals, controllers, lifecycle, query
cache, mutations, forms, plugins — through one dev-event bus (`root.__debug`). No
competitor (Redux DevTools, TanStack Query devtools, MobX tools) can correlate across
those layers, because they each see one slice. The exceptional version of this panel
answers the three questions every debugging session is actually about, in one place:

1. **"Why did this change?"** — click any state, see the causal chain that produced it
   (mutation → optimistic setData → fetch settle → entities backprop → cross-tab echo).
2. **"Why did this render/refetch?"** — subscription and effect tracing.
3. **"What happens if…?"** — act on live state from the panel: refetch, invalidate,
   edit cache, force error/loading, suspend/resume controllers, go offline.

Everything below is dev-only (`__DEV__`-gated in core; the panel is its own package so
prod bundles never see it). Do the sub-phases in order — 8A is the foundation everything
else stands on. **Prerequisite: T6.3 (devtools bug fixes) must land first.**

### 8A — foundation: event-driven, virtualized, correlated (no new features yet)

#### [ ] T8.1 — kill the 800ms poll: make the store fully event-driven
- **Files:** `packages/devtools/src/store.ts` (poll), `packages/core/src/devtools.ts`
  (`DebugEvent` union), `packages/core/src/query/client.ts` / `entry.ts` (emit sites)
- **Problem:** the panel polls the cache and diffs; it's both wasteful and lossy (events
  between polls are invisible; ordering is reconstructed by guesswork).
- **Fix:** extend the `DebugEvent` union so the cache narrates itself. Required new
  events (emit from core, `__DEV__`-gated, zero-cost when the bus has no subscribers —
  the bus already short-circuits): `cache:fetch-start`, `cache:fetch-settle`
  (success/error/aborted + duration), `cache:set-data` (with `source: 'mutate' | 'set' |
  'remote' | 'fetch'` — reuse the plugin event vocabulary from §13.2), `cache:invalidate`,
  `cache:gc`, `cache:subscribe` / `cache:unsubscribe` (per entry, with controller path of
  the subscriber), `mutation:enqueue/run/settle` (already partially there — add a stable
  `runId`), `snapshot:push/rollback/finalize` (the optimistic stack), `form:field-change`
  / `form:validate-settle` (name-pathed, value elided by default — see T8.7),
  `scope:provide/inject`, `plugin:event` (generic envelope so cross-tab/entities/
  mutation-queue traffic shows up — see T8.8).
- The store consumes ONLY events; delete the poller. Keep one initial snapshot request
  (the bus already supports live-tree replay on attach — extend the same replay to cache
  entries: on subscribe, core emits a synthetic `cache:snapshot` event per live entry).
- **Every event carries:** monotonic `seq`, `timestamp`, and a `causeId` where core can
  cheaply know it (a mutation's `runId` flows into the `setData` it triggers, the
  rollback it causes, and the `mutation:settle`; a fetch's id flows into its settle and
  set-data). This is the correlation backbone for 8B — do not skip it, it is cheap at
  emit time and impossible to reconstruct later.
- **Acceptance:** panel open, kanban example running — no `setInterval` in devtools; all
  cache changes appear within one frame; events are strictly `seq`-ordered.

#### [ ] T8.2 — virtualize everything; bound all memory
- **Files:** `packages/devtools/src/DevtoolsPanel.tsx` (tree + lists),
  `store.ts` (event ring buffer)
- Tree view, timeline, and cache list get windowed rendering (the repo already proves the
  pattern in `examples/virtualized-table` — reuse the approach, no new dependency).
- Event log becomes a ring buffer (default 10k events, configurable) with dropped-count
  indicator. Disposed controllers: retained but capped (from T6.3), visually greyed with
  their dispose-time state frozen.
- Replace per-event immutable path-clone + linear `findIndex` (`store.ts:447-481`) with a
  keyed `Map<pathKey, node>` index — O(1) per event.
- **Acceptance:** synthetic stress test in `packages/devtools/tests/`: 1,000 controllers,
  50k events — panel interactions stay under 16ms/frame (assert no O(n²) by timing the
  store apply loop, not the DOM).

#### [ ] T8.3 — search that works
- One omnibox (`/` to focus) that matches controller names/paths, query names, key args,
  mutation names, form field paths, and payload CONTENT — payload search runs against a
  lazily-built, invalidated-on-change stringified index, never per-keystroke
  re-stringification (fixes the T6.3 filter perf item properly). Results grouped by kind;
  Enter jumps to and highlights the match in its inspector.

### 8B — the killer feature: causal timeline ("why did this change?")

#### [ ] T8.4 — unified timeline with cause-chains
- New center-piece view: one time-ordered stream of ALL events (from T8.1), filterable by
  kind/controller/query, pausable (record button), with relative timestamps.
- **Cause-chain rendering:** events sharing a `causeId` render as one collapsible group:
  `updateName.run(runId=42)` ▸ `snapshot:push users/['1']` ▸ `cache:set-data (mutate)`
  ▸ `cache:fetch-settle error` ▸ `snapshot:rollback` ▸ `mutation:settle (error, 230ms)`.
  Clicking any row highlights the affected entry/controller in the side tree.
- **Payload diffs:** every `set-data` row expands to a structural before/after diff
  (added/removed/changed keys highlighted), not two JSON dumps. Write a small diff walker
  in the devtools package (structural-share's walker in core is a reference for cycle
  handling; do not import core internals).
- **Acceptance:** in the kanban example, failing a latest-wins mutation shows the full
  optimistic-apply → supersede-rollback → re-apply chain as one group, readable without
  scrolling through unrelated events.

#### [ ] T8.5 — subscription & effect tracing ("why did this render/refetch?")
- **Core side:** `__DEV__`-only — effects created via `ctx.effect` and query bindings
  already pass through wrappers (`instance.ts`, `use.ts`); add run-count + last-run-
  timestamp + a dev-only label (`ctx.effect(fn, { label? })` — optional param, ignored in
  prod). Emit `effect:run` events (throttled: coalesce per effect per frame).
- **React side:** `use()`/`useQuery`/`useField` in dev register their subscription with
  the bus (component name via `new Error().stack` is too fragile — use an optional
  `debugLabel` option plus React DevTools-style anonymous counting).
- **Panel side:** each controller node shows its effects with run counts (a hot effect —
  say >30 runs/s — gets a visual heat marker); each cache entry and field shows its live
  subscriber count and which controllers/components hold the subscription. This surfaces
  the classic bugs this library's audit itself found (collection reconcile storms,
  double-activated effects) *to the end user*.
- **Acceptance:** the T2.3 bug (before its fix) would be visibly diagnosable: writing the
  unrelated signal shows the collection's reconcile effect run-count climbing.

### 8C — act on state: the panel does things

#### [ ] T8.6 — debug control API + cache actions
- **Core:** add a `__DEV__`-only `DebugControls` object next to the bus on `root.__debug`:
  `{ refetch(entryRef), invalidate(entryRef), removeEntry(entryRef),
  setEntryData(entryRef, json), forceEntryState(entryRef, 'loading' | 'error'),
  suspendController(path), resumeController(path), disposeController(path) }`.
  Implement over existing internals (entry/state machinery, instance suspend/resume);
  `forceEntryState` sets the entry's signals directly and marks the entry "forced" until
  the next real fetch (mirror TanStack devtools' loading/error triggers).
- **Panel:** per cache entry — Refetch / Invalidate / Remove / Edit-as-JSON (validated,
  applied via `setEntryData`) / Force loading / Force error. Per controller node —
  Suspend / Resume / Dispose (with confirm). Per form — Reset, and per field — set value.
- **Guardrails:** every control action emits its own timeline event tagged
  `source: 'devtools'` so self-inflicted changes are never mistaken for app behavior.
- **Acceptance:** in reader-ssr example, forcing an entry's error state renders the app's
  error UI; a subsequent Refetch restores it — all without touching app code.

#### [ ] T8.7 — environment simulation + forms inspector
- **Offline toggle:** panel switch that (dev-only) patches `navigator.onLine` and
  dispatches `offline`/`online` window events — instantly exercises networkMode (T3.5),
  mutation-queue reconnect replay (T6.2), and persist behavior. Latency injection: a
  `delayFetches(ms)` debug control implemented in core's fetch wrapper (`__DEV__` only).
- **Forms inspector:** dedicated tab per form-owning controller: live field tree with
  value / dirty / touched / errors / isValidating per node, structural-dirty flag
  (from T5.1) visible, validation events in the timeline. Sensitive-value elision:
  fields render values only on click-to-reveal (never auto-logged into the event
  payloads — `form:field-change` events carry paths, not values, unless reveal is on).

#### [ ] T8.8 — plugin lens
- The generic `plugin:event` envelope (T8.1) gets a dedicated timeline lane per plugin:
  cross-tab shows sent/received/deduped messages with peer ids; entities shows
  walk/backprop counts per set-data (surfacing the "walk cost on every event" tax);
  mutation-queue shows enqueue/replay/attempt lifecycles with the durable entry contents.
  Plugins attach via a tiny helper exported from core (`emitPluginDebug(name, payload)`),
  so third-party plugins get the same lane for free.

### 8D — polish that makes it feel exceptional

#### [ ] T8.9 — session traces: export, import, share
- Record button → stop → export the event ring + initial snapshot as a single JSON file.
  The panel can IMPORT such a file and replay it read-only (scrub through the timeline,
  inspect any moment's derived state). This turns "it breaks sometimes on my machine"
  into an attachable artifact — the single highest-leverage feature for a young library's
  bug reports. Version the trace format (`{ format: 1, … }`).
- **Acceptance:** export from kanban, import into the panel in a fresh session, scrub to
  a mutation and read its cause-chain.

#### [ ] T8.10 — UX pass
- Keyboard: `/` search, `j/k` timeline walk, `Esc` close. Panel state (dock side, size,
  active tab, filters) persisted via `@kontsedal/olas-persist` (dogfooding). Respect
  `prefers-color-scheme` with manual override. Highlight-on-update pulses on tree nodes
  and cache rows (CSS only, no layout thrash). Empty states that teach: an empty timeline
  explains what will appear there; an entry with 0 subscribers explains gc timing.
- Update `packages/devtools/README.md` with annotated screenshots of each view, and add
  a "devtools tour" section to the kanban example README.

**Sequencing note:** 8A unblocks everything and fixes real costs — ship it as its own
release. 8B is the differentiator; 8C is what makes daily use sticky; 8D last. The
browser-extension idea stays in `BACKLOG.md` — the in-app panel is the product until the
panel itself is exceptional. Every store/reducer change in this phase needs tests in
`packages/devtools/tests/` (the store is plain TS — test it without rendering; keep
component tests for JsonView/StrictMode and virtualization only).

---

## Ordering & effort summary

| Phase | Contents | Rough effort |
|---|---|---|
| 0 | infra quick wins | half a day |
| 1 | query criticals (snapshot leak, hydration identity) | 1–2 days |
| 2 | lifecycle criticals + majors | 2–3 days |
| 3 | query majors + minors | 2–3 days |
| 4 | React adapter | 2 days |
| 5 | forms | 1–2 days |
| 6 | satellites | 2–3 days |
| 7 | delivery + docs | 1–2 days |
| 8 | devtools overhaul (8A → 8D) | 1.5–3 weeks, ship per sub-phase |

Do NOT add new features beyond what tasks explicitly introduce (`Mutation.status`,
`query.cancel`, `isPaused`, `FormIssue` routing, `TimingSignal.dispose`, `mustBeTrue`,
router initial state, and the Phase 8 devtools surface: `DebugEvent` extensions,
`DebugControls`, `emitPluginDebug`, dev-only `label`/`debugLabel` options). Everything
else on the wishlist stays in `BACKLOG.md`. The goal of this plan is: same surface,
correct at the intersections, shippable — plus devtools worth opening.
