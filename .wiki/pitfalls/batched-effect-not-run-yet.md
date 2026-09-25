---
name: batched-effect-not-run-yet
description: Inside batch() or an effect body, a signal write schedules the effects that depend on it for later; code that writes and then peeks at state those effects own sees the old state.
type: pitfall
covers:
  - packages/core/src/forms/field.ts:627-643
edges:
  - { type: related, target: ../modules/forms.md }
  - { type: related, target: ../modules/signals.md }
  - { type: tested-by, target: ../../packages/core/tests/form-regressions.test.ts }
last_verified: 2026-09-25
confidence: medium
---

# Pitfall: inside a batch, the effect a write wakes has not run yet

`@preact/signals-core` defers effects while a batch is open. `batch(fn)` opens one, and so does every effect run: an effect body is a batch. A write inside either marks the dependent effects, and they run when the outermost batch ends. Until then, any signal those effects would write still holds its old value.

Code that writes a trigger and then `peek()`s at what the triggered effect sets reads stale state. Outside a batch the effect runs inside the write, so the same code works, and a test that calls it at top level passes.

## Where it bit

`FieldImpl.revalidate()` bumps `revalidateTrigger$` and then reads `validating$` to decide whether to wait (`field.ts:627-643`). Called from `form.submit()` inside `batch(() => { username.set('taken'); form.submit(save) })`, or from an effect that set a field and submitted, the validator effect had not run. `validating$` read `false`, `revalidate()` resolved with the held `isValid: true`, and `save` ran while the async username check was still pending. Spec §8.6 says a submit validates first in every calling context.

## The fix and the test for it

- Check whether the effect ran. `FieldImpl.runValidators` bumps `runId` on every run. `revalidate()` notes it before the bump, and an unchanged `runId` after it means the effect is waiting for the batch.
- Wait a microtask then. A batch is synchronous, so by the next microtask it has ended and the effect has run. The state read after that belongs to the pass the write asked for.
- Do not run the effect's work eagerly in its place. The effect re-tracks its dependencies on every run, and a copy run outside it tracks nothing and runs the validators twice.

A regression test for this class calls the code inside `batch()` and inside an `effect`, not only at top level. `form-regressions.test.ts`, "submit() inside batch() or an effect waits for the async check", does both.
