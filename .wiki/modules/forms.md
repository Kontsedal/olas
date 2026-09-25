---
name: forms
description: Field, Form, FieldArray, validators. Aggregate computeds branch on brand markers.
type: module
covers:
  - packages/core/src/forms/types.ts
  - packages/core/src/forms/field.ts
  - packages/core/src/forms/form.ts
  - packages/core/src/forms/form-types.ts
  - packages/core/src/forms/validators.ts
  - packages/core/src/forms/index.ts
  - packages/core/src/forms/bind.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/form.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/form-regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/validators.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../decisions/brand-markers-not-classes.md }
  - { type: related, target: ../decisions/forms-are-read-signals.md }
  - { type: related, target: ../pitfalls/fieldarray-factory-uses-initial.md }
last_verified: 2026-09-25
confidence: high
---

# `packages/core/src/forms/`

## Purpose

Form primitives — `Field<T>`, `Form<S>`, `FieldArray<I>` — plus stdlib validators (`required`, `mustBeTrue`, `min`, `max`, `minLength`, `maxLength`, `email`, `pattern`) and `debouncedValidator`. `required` accepts a boolean `false`, which is a legitimate value. `mustBeTrue` is the consent-checkbox rule (T5.3). Spec §8, §20.7.

## Files

- **`types.ts`** — `Validator<T>`, plus `ValidatorResult` as `string | null | FormIssue[]` and `FormIssue` as `{ path: (string|number)[]; message }`. Validators may target descendant fields by path (T5.2).
- **`validators.ts`** — stdlib functions + the Standard-Schema `validator()` adapter. Stdlib fns return `Validator<T>` and short-circuit on `null` and `undefined` so they compose with `required()`. `validator(schema)` returns **all** issues as `FormIssue[]` (each with its `path`) — `[]` on success.
- **`field.ts`** — `FieldImpl<T>` class + `createField` factory + `debouncedValidator`. Field IS a `ReadSignal<T>`, delegating `.value`, `peek` and `subscribe` to an internal signal. It owns the validator runner. Three error channels merge into `errors`: `validatorErrors$` from its own validators, `serverErrors$` from `setErrors`, and `formErrors`, a `RoutedErrors` with one list per routing form (T5.2). It also holds the helpers the form runners share: `asyncValidatorFlags` and `callValidators` for the sync-first order, `RoutedErrors`, and `addNodeDisposeHook`.
- **`bind.ts`** — the `ctx`-taking `createField`, `createForm` and `createFieldArray`. Each registers one `cleanup` entry and hands the unregister function to the node's dispose hook, so an item a `FieldArray` drops leaves no entry on the controller (1.0).
- **`form-types.ts`** — heavy type machinery: `FormSchema`, `FormValue<S>`, `FormErrors<S>`, `FieldArrayValue<I>`, `Form<S>`, `FieldArray<I>`. Plus the brand symbols.
- **`form.ts`** — `FormImpl` and `FieldArrayImpl` + factories + brand-based predicates + the form-issue router (`resolveNode` and `routeFormIssues`).
- **`index.ts`** — re-exports validators + the `Validator`, `ValidatorResult` and `FormIssue` types.

`form.ts` is the longest file (~1,400 lines). Read it side-by-side with `form-types.ts`.

## Brand markers

```ts
const FORM_BRAND        = Symbol.for('olas.form')
const FIELD_ARRAY_BRAND = Symbol.for('olas.fieldArray')

isForm(x)        // x[FORM_BRAND] === true
isFieldArray(x)  // x[FIELD_ARRAY_BRAND] === true
isField(x)       // neither — defaults to Field
```

Used everywhere `Form`/`FieldArray`/`Field` are mixed in a child slot. We prefer brands over `instanceof` because the impl class isn't exported (so `instanceof` would couple consumers to internals) and because `Symbol.for(...)` survives bundling boundaries. See `../decisions/brand-markers-not-classes.md`.

## Aggregate computeds — the traversal pattern

`Form.value`, `errors`, `isValid`, `isDirty`, `touched`, `isValidating` are all `computed(() => ...)`. They iterate `Object.values(this.fields)`.

- **`value`** reads `child.value` for every child with no branch. `Field`, `Form` and `FieldArray` are each a `ReadSignal` of their value (`form.ts:390-397`). See `../decisions/forms-are-read-signals.md`.
- **`errors`, touched, validation and path resolution** branch on the child's brand, because the node kinds differ there: a `Form` has `fields`, a `FieldArray` has `items`, and a `Field` has neither.

`applyPartial` (behind `set` and `setAsInitial`) calls the child's own `set` or `setAsInitial`, which all three kinds share.

## Validator runner (in FieldImpl)

```
effect(() => {
  value = this.value$.value              # tracked
  revalidateTrigger$.value               # tracked — bump to force re-run
  if locked: runId++, errors=[], return  # validateOn gate
  abort previous run; myId = ++runId
  round 1: call every validator not flagged async, in order
           (a promise returned here flags it async and is held)
  if round 1 failed: abandon held promises, errors=sync, return
  round 2: call the async-flagged validators
  if nothing pending: errors=[], validating=false, return
  validating=true; errors=[]
  Promise.allSettled(pending).then(results => {
    if myId !== runId || disposed: return   # superseded, reset or disposed
    errors = collect(results); validating=false
  })
})
```

The whole body runs inside an `effect`, so any signal read inside any validator becomes a tracked dependency — that's what makes cross-field rules like `(v) => v === password.value ? null : 'mismatch'` reactive. The async portion (`.then`) is outside the tracking scope. A validator that returns a `FormIssue[]` is flattened to its messages here (`messagesFromResult` — a leaf field has no descendants to route paths to).

**`validateOn` gate.** A field can defer its first validation. `'change'` is the default and runs immediately. `'blur'` gates the first run on `markTouched()`. `'submit'` gates it on `revalidate()` and `Form.validate()`. A reactive `validateUnlocked$` gate short-circuits the runner while locked. Once unlocked it stays unlocked, so subsequent changes re-validate, and `reset()` re-locks. Covered by `form.test.ts`.

**`isValid` stability (T5.3).** `isValid` reads live `errors` when settled, but **holds the last settled validity while `isValidating`**, through a `lastValid$` signal updated at every settle point. Without this, a `debouncedValidator` cleared `validatorErrors$` on each async start, `isValid` strobed to `false` on every keystroke, and a bound submit button flickered. A field with no prior settled run defaults to valid, so there is no false-invalid flash on mount. This replaced the older "treat-as-invalid-while-validating" rule (spec §8.2 updated).

`debouncedValidator(fn, ms)` returns a validator whose Promise resolves after `ms` (or rejects with AbortError if the signal aborts first). Its return type is the precise `(v, s) => Promise<string | null>` rather than the widened `Validator<T>`, so a direct caller storing the result in a `string | null` signal type-checks. It stays assignable wherever a `Validator<T>` is expected (`field.ts:715-723`).

**Async validators start only after every sync one passes (1.0, spec §8.1).** `callValidators` in `field.ts` runs a pass in two rounds (`field.ts:51-82`). A pass cannot tell a sync validator from an async one before calling it, so `asyncValidatorFlags` keeps one flag per validator. A validator counts as async when it is declared `async`, detected with `Object.prototype.toString`, or once it has returned a promise, and the flag never clears. Round one calls the unflagged validators and collects every sync error. When one failed, the async validators are not called at all, so `[required(), checkUsername]` never sends `checkUsername('')`. Before this, a pass called every validator and only then looked at the results. One gap remains: a validator that returns a promise without being declared `async`. It runs in round one until its first promise, and a sync failure in that pass aborts it. The field, form and field-array runners share the helper, the last two through `runLevelValidators` in `form.ts`. Pinned by `form-regressions.test.ts`, "async validators start only after every sync validator passes".

**An abandoned promise settles quietly (1.0).** A promise round one started is abandoned when the pass fails. `abandonAsyncResults` in `utils.ts` aborts it and attaches a no-op handler. Without it, the rejection that the abort caused was unhandled and logged an `AbortError`. Pinned by `regressions.test.ts`, "an async validator abandoned by a failing sync one settles quietly".

**Dispose and reset end a check in flight (1.0).** `FieldImpl.dispose()` sets `validating$` to `false` (`field.ts:478-493`), and `FormImpl.dispose()` and `FieldArrayImpl.dispose()` do the same for `topLevelValidating$`. The settle callback returns early on a disposed node, so without this a `revalidate()`, `validate()` or `submit()` waiting on the pass never resolved. A row removed from a field array mid-submit left `isSubmitting` stuck at `true`, and every later `submit()` returned `busy`. `submit()` now resolves `{ ok: false, reason: 'disposed' }` for a form disposed while it validated. `reset()` and the locked branch of the runner bump `runId`, so a validator that ignores its `AbortSignal` cannot land its result on a reset field. Pinned by `form-regressions.test.ts`.

## Form-level validators that target fields (T5.2)

A validator on `FormOptions.validators` or on `FieldArrayOptions.validators` may return a `FormIssue[]` instead of a `string`. `FormImpl.runTopLevelValidators` and `FieldArrayImpl.runTopLevelValidators` collect all results, sync and async, via `appendIssues`. They hand them to `routeFormIssues(this, issues, topLevelErrors$, lastTargets)` in `form.ts`, which passes itself as the `source` of every write:

- **empty-path** (and unresolvable) issues → the node's own `topLevelErrors$`.
- **path** issues → `resolveNode(this, path)` walks keys on a Form and numeric indices on a FieldArray to reach the target node, then calls its `setFormErrors(msgs, source)`, where `source` is the routing node.

Each node type (`FieldImpl`, `FormImpl`, `FieldArrayImpl`) exposes `setFormErrors`. On a Field it feeds `formErrors`, which merges into `errors`. On a Form or FieldArray it feeds `parentFormErrors`, which merges into that node's **`topLevelErrors`** getter, now a `computed` over its own errors plus the parent-injected ones, and is factored into `isValid`. `routeFormIssues` clears any target written last run but not this one, tracked in `lastFormErrorTargets`, so a fixed rule removes its message.

**One list per router (1.0).** Both channels are a `RoutedErrors` from `field.ts`, which keeps one list per `source` and shows them merged in the order the routers first wrote (`field.ts:91-106`). An inner form's rule and an outer form's rule can target the same field. With one shared list, the outer rule's clear pass erased the inner rule's still-failing message, so the field read `errors: []` and `isValid: true`. Now each router replaces or clears only its own list. An empty write from a router with no list is a no-op, which keeps a whole-tree clear pass from waking subscribers. Pinned by `form-regressions.test.ts`, "form-level validators that target the same field".

**The form-level run is the only writer of the routed channels (1.0).** `FieldImpl.reset()` and `setAsInitial()` leave `formErrors`, and `FormImpl.reset()` and `FieldArrayImpl.reset()` leave `topLevelErrors$` and `parentFormErrors`. A reset that changes the form's value re-runs the validator effect, which recomputes them. A reset that leaves the value unchanged does not re-run it, and clearing the channels there hid a rule that still failed: `form.isValid` read `true` until the next edit. Keeping the last result also keeps async runs sane, because a no-op reset starts no new run and cannot drop an in-flight one's result. Pinned by `form.test.ts`, "regression: a no-op reset keeps form-level errors visible". The router runs inside the validator `effect`, but only *reads* the tracked form `value` and *writes* error signals, peeking elsewhere. It therefore adds no spurious dependencies and cannot loop, because errors are not part of `value`. Pinned by `regressions.test.ts` under R-F5.2. The Standard-Schema path from `validator(schema)` to `FormIssue[]` is pinned by `standard-schema.test.ts`.

## `Form.set(partial)` — batched deep merge

Iterate `Object.entries(partial)`. For each key, dispatch on the child:

- Form → child.set(val)
- FieldArray → `child.clear()`, then `child.add(item)` for each item
- Field → child.set(val)

All inside `batch(() => ...)` so subscribers see one notification.

## `FieldArray<I>` — dynamic children

`itemFactory: (initial?: ItemInitial<I>) => I` produces a new item. **The factory MUST consume the `initial` argument** or `add(x)` will silently ignore `x`. Canonical pattern:

```ts
createFieldArray(ctx, (initial) => createField(ctx, initial ?? ''))
createFieldArray(ctx, (initial) => createForm(ctx, schema, { initial }))
```

See `../pitfalls/fieldarray-factory-uses-initial.md`.

`remove(i)` calls `.dispose()` on the removed item (Field/Form/FieldArray all implement it). `clear()` disposes all items.

**A dropped item leaves nothing on the controller (1.0).** The documented factory `(i) => createField(ctx, i ?? '')` registers a controller `cleanup` entry per item. `remove`, `clear`, `set` and `reset` disposed the item but kept the entry. A hundred add and remove cycles left a hundred entries, and the root's dispose called each dropped field's `dispose` again. `CtxInternals.register` now returns an unregister function, and `bind.ts` passes it to the node through `addNodeDisposeHook`, so the node's own `dispose` releases its entry. `createForm` and `createFieldArray` register one entry each, and their dispose hook also stops the devtools binding. Pinned by `form-regressions.test.ts`, "field arrays release the lifecycle entries of the items they drop".

**Structural dirtiness (T5.1).** `FieldArray.isDirty` is `structurallyDirty$ || anyItemDirty`. `add`, `insert`, `remove`, `move` and `clear` flip the `structurallyDirty$` signal, and `reset()` and a `setAsInitial()` re-seat clear it. `rebaseInitial()` sets it, for the first-value case below. Item-level dirtiness alone missed add, remove and move. A reactive `initial: () => queryData` under the default `resetOnInitialChange: 'when-clean'` then re-seated the array on a background refetch and deleted rows the user had just added; the guard is in `FormImpl` construction at `form.ts:287-334`. Construction seeds items directly rather than through `add()`, so a fresh array is clean. Pinned by `regressions.test.ts` (R-F5.1).

## What's NOT implemented yet

- `form.fieldAt('a.b.c')` path-typed lookup — spec §20.7 says this is "deferred to post-v1". Use `form.fields.a.fields.b.fields.c` chained access.

Reactive `initial` **is** implemented. This page's prior "not reactive between resets" note was bootstrap-era drift. An `initial: () => …` thunk runs in a tracking scope and re-applies when its tracked signals change, gated by `resetOnInitialChange`, whose values are `'when-clean'` by default, `'always'` and `'never'`. The `'when-clean'` guard consults `isDirty`, which now includes the structural FieldArray edits described above. Spec §8.4, §8.5.

**The first value fills the untouched leaves and keeps every edit (1.0).** The effect is at `form.ts:295-330`. The first defined value goes through `seatKeepingEdits` (`form.ts:460-478`) unless the mode is `'always'`. A clean child takes the value through `setAsInitial`, a dirty nested form recurses, and a dirty field or field array calls `rebaseInitial`. A field's `rebaseInitial` keeps its value, moves `initial`, and recomputes `dirty$` against it (`field.ts:423-433`). A field array's keeps its items, replaces `initialItems`, and marks the array structurally dirty, because its rows were not built from the new baseline. The `SeatTarget` type names what the walk reads of a child (`form.ts:62-71`).

Two rounds of history sit behind this. The effect first seated the first value unconditionally, so data that loaded after the user started typing overwrote the edit. The next round put the form-wide dirty check on the first value too. That kept the edit but left every other field at its empty seed: one keystroke in `name`, a `form.set({ country })` default in the factory, or a `tags.add()` before `createForm` blocked the whole seat, and a save wrote blanks. Pinned by `form-regressions.test.ts`, "the first initial value seats the leaves the user has not edited".

`initialSeated` records the first seat (`form.ts:317-322`). After it the form-wide guard applies: `'when-clean'` skips a dirty form, and `'never'` ignores the value. A later run reaches that check after construction, but the code still calls `computeBool('isDirty')` rather than read `this.isDirty`, which the constructor builds after the effect's first run. A throw from `initialFn()` is caught and routed through the form's validator reporter to `onError` as `kind: 'effect'`. Uncaught, it escaped into whatever wrote the tracked signal, and a refetch whose data changed shape rejected with the form's `TypeError`. Pinned by "a throwing reactive initial()".

**`reset()` reads `initial()` through `readInitial` (1.0).** A thunk runs untracked, so a `reset()` inside an effect does not make the thunk's reads that effect's dependencies. A throw reaches `onError` as the effect's does, and the fields keep the baselines they reset to (`form.ts:514-529`). A `reset()` that seats a defined value sets `initialSeated`, so `'never'` does not re-seat after it. Pinned by "reset() reads initial() the way the reactive seat does" and "'never' after a reset() that seated the form".

## Partials with prototype keys (1.0)

`Form.applyPartial`, behind `set` and `setAsInitial`, skips a key that is not an own property of `fields`. `fields` is a plain object, so a partial parsed from JSON with `__proto__`, `constructor` or `toString` found an `Object.prototype` member and threw `node.set is not a function`. Pinned by `regressions.test.ts`, "a form partial carrying prototype keys".
