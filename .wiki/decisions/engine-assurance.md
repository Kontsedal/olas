---
name: engine-assurance
description: How the 1.0 engine is checked beyond example tests — fast-check property models, per-package coverage gates, and a Stryker mutation run — and what they found.
type: decision
covers:
  - vitest.config.ts
  - vitest.stryker.config.ts
  - stryker.config.json
  - packages/core/tests/property/helpers.ts
  - packages/core/tests/property/entry.property.test.ts
  - packages/core/tests/property/infinite.property.test.ts
  - packages/core/tests/property/mutation.property.test.ts
  - packages/core/tests/mutants-client.test.ts
  - packages/core/tests/mutants-entry.test.ts
  - packages/core/tests/mutants-infinite.test.ts
  - packages/core/tests/mutants-instance.test.ts
  - packages/core/tests/mutants-mutation.test.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/property/entry.property.test.ts }
  - { type: related, target: ../entities/entry.md }
  - { type: related, target: canonical-vs-optimistic-writes.md }
last_verified: 2026-09-24
confidence: medium
---

# Engine assurance

Example tests pin the cases someone thought of. 1.0 adds three checks for the cases nobody did.

## Property models (`packages/core/tests/property/`)

Each file drives an engine object through a random sequence of operations and checks it against a small model after every step, 1,000 runs per property (`NUM_RUNS` in `helpers.ts`).

- **`Entry`:**
  - **Ops:** start, refetch, invalidate, cancel, reset, tracked and canonical `setData`, rollback and finalize of a random snapshot, `applyHydration`, and settling a random fetch out of order. A settle can deliver a value, an error, or a self-abort.
  - **Asserts:** a superseded fetch never writes; nothing stays `isFetching` or `'pending'`; `hasPendingMutations` is true exactly while a snapshot is live; and rolling every snapshot back in random order restores the canonical value.
- **`InfiniteEntry`:**
  - **Ops:** the same, plus next and previous pages, writes that change the page count, and multi-page refetches.
  - **Asserts:** `pages` and `pageParams` stay aligned; a superseded page request never writes; and each paging flag is true exactly while its direction owns the entry.
- **Mutations:**
  - **Modes and ops:** one property per concurrency mode, through the public API, with an optimistic `setData` and a recording plugin. The ops include microtask ticks, so an abort can land just after `mutate` finishes.
  - **Asserts:** every `run()` settles; `isPending` ends false; `waitForIdle()` resolves and does not answer early; plugins see exactly one start and one outcome per run; `serial` never overlaps two `mutate` calls; and `latest-wins` rolls back before the next `onMutate`.

The op sequences are plain arrays with an explicit `flush` op, not `fc.commands`. `fc.commands` awaits between steps, which lets engine callbacks run at points the model cannot control. The plain loop keeps "settle a fetch, then supersede it before its callback runs" reachable. Each model was deliberately broken once to confirm its property fails.

## Coverage gates (`vitest.config.ts`)

The 1.0 coverage pass took core to 99.4% lines / 94.9% branches and every satellite to ≥ 99% lines / ≥ 90% branches (1,549 tests). The gates sit a little below those levels, so CI fails on a regression without flaking on jitter:
- one global gate;
- one for `packages/core/src/**`;
- one per satellite package, so a package cannot slip while the others carry it.

**What stays uncovered, by kind:**
- the production-only side of `if (__DEV__)`, because tests run with `__DEV__ = true`;
- guards against states the callers rule out: a disposed entry, a double dispose, a negative subscriber count;
- `typeof window` checks that only matter during server rendering;
- `catch` blocks around calls that cannot throw.

The coverage agents' reports listed each such branch with its reason. Dead code they found was removed: `isField`, `LifecycleList.size` and `QueryClient.inflightCount`.

## Mutation testing (`pnpm mutation`)

Stryker mutates `query/{entry,infinite,client,mutation}.ts` and `controller/instance.ts` and runs core's tests against each mutant (`vitest.stryker.config.ts`, per-test coverage). It is a one-off check, not a CI gate: a full run takes a long time, and the score moves with every refactor. The first run's result is below.

<!-- stryker-result -->

**Result, 2026-09-24 (Stryker 10, 3,516 mutants, about 12 minutes on 12 workers):**

| File | First run | After closing the gaps |
|---|---|---|
| `query/client.ts` | 79.3% | 90.1% |
| `query/mutation.ts` | 71.4% | 87.1% |
| `query/entry.ts` | 77.8% | 87.0% |
| `controller/instance.ts` | 80.0% | 86.5% |
| `query/infinite.ts` | 71.8% | 86.4% |
| **All five** | **76.5%** | **87.8%** |

The first run left 815 mutants alive: 779 that survived and 36 that no test reached. Five agents triaged them, one per file, and put each into one of four classes:
- **GAP** (400): an observable change no test pinned. Each got a test in `packages/core/tests/mutants-<file>.test.ts`, 167 tests in all. Every agent then applied each of its file's mutants to a scratch copy and ran its new file against it. Each GAP mutant failed the tests, and each mutant in the next two classes still passed. The second Stryker run agrees.
- **EQUIVALENT** (270): no observable change. The common shapes:
  - `__DEV__` forced to `true`, which it already is under test;
  - a guard the caller already guarantees;
  - a loop over an array that is empty on that path;
  - a `catch` around a call that cannot throw.
- **NOT-WORTH** (144): visible only in message text, a dev-only warning, a cosmetic devtools field, or memory held after dispose.
- **BUG** (7): the original code was wrong, which "What they found" lists.

The 429 left after the second run are those two classes, plus the mutants the bug fixes added. They are not a to-do list. What would make a real gap visible is a GAP-class mutant among them, so re-triage after a refactor, not the whole list.

Two findings about the tool itself:
- **`mergeConfig` concatenates arrays.** `vitest.stryker.config.ts` must set `include` after the merge. Merged in, it adds core's glob to the root's every-package glob, and the run tests every package.
- **Stryker reports a mutant as survived when its run found no tests.** Deleting the sandbox while a run was live turned 1,400 mutants into false survivors, 0% on two files. A file with zero kills is a harness fault until shown otherwise.

## What they found

The three checks found 29 real bugs before 1.0: 22 from the coverage pass and the property models, 7 from the Stryker triage. All of them are fixed, each with a regression test that fails on the old code. The changeset `engine-assurance-fixes.md` lists them. The engine ones from the first two checks:

- **Hydration did not rebase pending optimistic snapshots**, in both `Entry` and `InfiniteEntry`. A rollback after `root.hydrate` restored the pre-hydration value.
- **An infinite query's canonical `write` / `replace` did not rebase** either, so a pending optimistic rollback undid it.
- **Infinite paging flags followed the wrong request.** A superseded request cleared a newer one's flag, and a refetch did not clear a stale one.
- **A mutation that failed as it was aborted** reported `cancel` to plugins, while its caller got the real error.
- **`serial`: `waitForIdle()` did not count queued runs.**
- **`resume()` ignored an `enabled` that turned false while suspended.**
- **Infinite `flat` without `itemsOf` read `[]`** while retained pages showed.
- **`root.hydrate` skipped the payload version check.**
- **A form's `isValid` flickered to false** during any child's async check.
- **A rejected async form-level validator was ignored.**

The rest were in zod, realtime, entities, mutation-queue and devtools.

The Stryker triage found seven more, all in the engine. It turned them up while reasoning about why a mutant survived, not in the mutants themselves. Each is pinned in `regressions.test.ts` ("W9 mutation-testing regressions") or `query-focus-online.test.ts` ("reconnect dispatch"):

- **`dispose()` inside `onMutate` did not cancel the run.** The run registered its abort handle after `onMutate` returned, so `mutate` ran with a signal that never fired, and `status` stayed `'pending'`.
- **An `AbortError` thrown by `mutate` itself counted as a cancellation.** `status` stayed `'pending'`, and the mutation queue kept the entry to replay.
- **A lifecycle handler that disposed or re-suspended the controller did not end the pass.** `resume()` switched effects back on for a disposed controller.
- **One `online` event spun without end** while `navigator.onLine` still read false. The fan-out iterated the live subscriber set, and a parked entry re-subscribes from inside its handler.
- **An outdated fetch rethrew its own error.** `invalidate()` routed it to `onError`, and `prefetch()` rejected with it. §5.6 says those errors are dropped.
- **A `prefetch()` in flight at `root.dispose()` armed a gc timer afterwards,** holding a Node process open for `gcTime`.
- **An infinite query's `isLoading` stuck at true** when a write filled the first load and a page request then took over.
