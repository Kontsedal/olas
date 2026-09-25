import type { Field } from '../controller/types'
import type { DevtoolsEmitter } from '../devtools'
import {
  batch,
  type Computed,
  computed,
  effect,
  type ReadSignal,
  type Signal,
  signal,
  untracked,
} from '../signals'
import { readOnly } from '../signals/readonly'
import { abandonAsyncResults, isAbortError, isThenable } from '../utils'
import type { Validator, ValidatorResult } from './types'

/**
 * Flatten a single validator result to plain message strings for a leaf field.
 * A leaf has no descendants, so a `FormIssue[]`'s paths don't route anywhere —
 * every issue's `message` applies to this field. `null` → no messages.
 */
function messagesFromResult(result: ValidatorResult): string[] {
  if (result == null) return []
  if (typeof result === 'string') return [result]
  return result.map((issue) => issue.message)
}

/**
 * The message a validator bug shows on its node. Prod shows a generic one, so
 * an internal error's text does not leak into form errors; the real error
 * still reaches the reporter (T5.3). Dev keeps the message.
 */
export function thrownMessage(err: unknown): string {
  return __DEV__ ? (err instanceof Error ? err.message : String(err)) : 'Validation failed'
}

/**
 * Rejections that stand for a bug in a validator rather than a failed check:
 * a `debouncedValidator` whose `fn` threw synchronously or returned no
 * promise. An async settle reports them, as a sync validator throw is
 * reported, besides showing their message.
 */
const validatorBugs = new WeakSet<object>()

function markValidatorBug(err: unknown): object {
  const bug =
    (typeof err === 'object' && err !== null) || typeof err === 'function'
      ? (err as object)
      : new Error(String(err))
  validatorBugs.add(bug)
  return bug
}

/**
 * What a rejected async validator shows on its node: nothing for an abort, and
 * the reason's message otherwise. A validator bug also goes to `report`,
 * which routes it to `onError`; a reporter that throws is ignored.
 */
export function rejectionMessage(reason: unknown, report: (err: unknown) => void): string | null {
  if (isAbortError(reason)) return null
  if (typeof reason === 'object' && reason !== null && validatorBugs.has(reason)) {
    try {
      report(reason)
    } catch {
      // The reporter must not propagate.
    }
    return thrownMessage(reason)
  }
  return reason instanceof Error ? reason.message : String(reason)
}

/** A validator as one pass calls it: the value and the pass's `AbortSignal`. */
type PassValidator<V> = (
  value: V,
  signal: AbortSignal,
) => ValidatorResult | Promise<ValidatorResult>

/**
 * One flag per validator: `true` once it counts as async. A pass cannot tell a
 * sync validator from an async one before calling it, so a validator counts as
 * async when it is declared `async`, or once it has returned a promise. The
 * flag never goes back to `false`.
 */
export function asyncValidatorFlags(validators: ReadonlyArray<unknown>): boolean[] {
  return validators.map((v) => Object.prototype.toString.call(v) === '[object AsyncFunction]')
}

/**
 * Call one pass's validators, sync ones first (spec §8.1). The first round
 * calls, in declared order, every validator not flagged async. `onResult`
 * collects a synchronous result and says whether it failed; `onThrow` handles
 * a synchronous throw, which always fails. When the first round fails, the
 * async validators are not called at all. Otherwise the second round calls
 * them. A validator not yet flagged can return a promise in the first round,
 * before a failure is known; the caller abandons what `pending` holds then.
 * `skipAsync` leaves out the second round, for a pass that only re-checks the
 * sync validators.
 */
export function callValidators<V>(
  validators: ReadonlyArray<PassValidator<V>>,
  isAsync: boolean[],
  value: V,
  signal: AbortSignal,
  onResult: (result: ValidatorResult) => boolean,
  onThrow: (err: unknown) => void,
  skipAsync = false,
): { failed: boolean; pending: Promise<ValidatorResult>[] } {
  const pending: Promise<ValidatorResult>[] = []
  let failed = false
  const call = (i: number): void => {
    try {
      const result = (validators[i] as PassValidator<V>)(value, signal)
      if (result instanceof Promise) {
        isAsync[i] = true
        pending.push(result)
      } else if (onResult(result)) {
        failed = true
      }
    } catch (err) {
      onThrow(err)
      failed = true
    }
  }
  const secondRound: number[] = []
  for (let i = 0; i < validators.length; i++) {
    if (isAsync[i]) secondRound.push(i)
    else call(i)
  }
  if (!failed && !skipAsync) for (const i of secondRound) call(i)
  return { failed, pending }
}

/**
 * The errors that form-level validators routed onto one node (T5.2), one list
 * per routing node. An inner form's rule and an outer form's rule can both
 * target the same field. Each router replaces only its own list, so fixing one
 * rule leaves the other rule's message in place. `merged` is what the node
 * shows, in the order the routers first wrote.
 */
export class RoutedErrors {
  private readonly bySource = new Map<object, string[]>()
  readonly merged: Signal<string[]> = signal([])

  set(source: object, errors: ReadonlyArray<string>): void {
    if (errors.length === 0) {
      // Nothing from this router, before or now: leave subscribers asleep.
      if (!this.bySource.delete(source)) return
    } else {
      this.bySource.set(source, [...errors])
    }
    const out: string[] = []
    for (const list of this.bySource.values()) out.push(...list)
    this.merged.set(out)
  }
}

/**
 * Internal — run `fn` once when `node` (a field, form or field array built by
 * core) disposes, or at once if it already has. The `createField`,
 * `createForm` and `createFieldArray` bindings release their controller
 * lifecycle entry this way, so an item a `FieldArray` drops does not stay
 * registered on the controller. A node without the hook (a test fake) is
 * skipped.
 */
export function addNodeDisposeHook(node: object, fn: () => void): void {
  const impl = node as { addDisposeHook?: (fn: () => void) => void }
  if (typeof impl.addDisposeHook === 'function') impl.addDisposeHook(fn)
}

/** Runs and drops the hooks `addDisposeHook` collected. */
export function runDisposeHooks(hooks: Array<() => void> | null): void {
  if (hooks === null) return
  for (const fn of hooks) fn()
}

/**
 * Structural equality used by `Field.set` to decide whether a write returns
 * the field to its initial value (clearing `isDirty`). Cheap path for
 * primitives + `Object.is`; deep walk for arrays and plain objects. Class
 * instances, Map, Set, Date fall back to reference identity — same trade-off
 * `structural-share.ts` makes for cache data. `fakeField` uses it too.
 */
export function isStructurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!isStructurallyEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const protoA = Object.getPrototypeOf(a)
  const protoB = Object.getPrototypeOf(b)
  // Plain-object guard only — class instances aren't safe to walk by keys.
  if (protoA !== Object.prototype && protoA !== null) return false
  if (protoB !== Object.prototype && protoB !== null) return false
  const keysA = Object.keys(a as Record<string, unknown>)
  const keysB = Object.keys(b as Record<string, unknown>)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (!Object.hasOwn(b as object, k)) return false
    if (
      !isStructurallyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    ) {
      return false
    }
  }
  return true
}

/** A plain object or an array: the shapes `isStructurallyEqual` walks by content. */
function isPlainData(value: unknown): value is object {
  if (Array.isArray(value)) return true
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A structural copy of the plain data in `value`. Plain objects and arrays are
 * copied at every depth; anything else, such as a class instance, a `Date` or
 * a `Map`, is kept by reference. That is exactly the part `isStructurallyEqual`
 * compares by content, so a copy compares equal to its source.
 *
 * A field, a form and a field array keep their baselines this way. A Svelte
 * nested bind edits the value it was handed in place, and with a shared
 * baseline that edit reached what `reset()` restores. A spread copies an own
 * `__proto__` key as data, and a null-prototype object keeps its prototype
 * (`.wiki/pitfalls/proto-key-assignment.md`). A cycle is copied as a cycle.
 */
export function copyPlainData<T>(value: T): T {
  return isPlainData(value) ? (copyPlainNode(value, new Map()) as T) : value
}

function copyPlainNode(value: object, seen: Map<object, unknown>): unknown {
  const done = seen.get(value)
  if (done !== undefined) return done
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length)
    seen.set(value, out)
    for (let i = 0; i < value.length; i++) {
      // Keep holes as holes.
      if (!(i in value)) continue
      const item: unknown = value[i]
      out[i] = isPlainData(item) ? copyPlainNode(item, seen) : item
    }
    return out
  }
  const out: Record<string, unknown> =
    Object.getPrototypeOf(value) === null
      ? Object.assign(Object.create(null), value)
      : { ...(value as Record<string, unknown>) }
  seen.set(value, out)
  // Each key is already an own data property of `out`, so the assignment
  // writes it, `__proto__` included, and calls no setter.
  for (const k of Object.keys(out)) {
    const item = out[k]
    if (isPlainData(item)) out[k] = copyPlainNode(item, seen)
  }
  return out
}

/**
 * A field's value in a box of its own. A signal skips a write of the value it
 * holds, and inside a `batch()` it also skips a write that ends where it
 * started. A new box on every write lets `FieldImpl` decide what counts as a
 * change: an object written again does, a primitive written again does not.
 */
type Held<T> = { readonly v: T }

/**
 * Hook attached by `createField` and `createForm` so a Field can publish
 * `field:validated` devtools events with its owning controller path + the
 * field's name within the form schema. See devtools §20.9 and FieldImpl.bind.
 */
export type FieldDevtoolsOwner = {
  controllerPath: readonly string[]
  fieldName: string
  emitter: DevtoolsEmitter
}

/**
 * Optional reporter for synchronous validator throws — wired in by `createField`
 * (and `createForm` for leaf fields inside a form) so a thrown validator
 * doesn't escape the signal effect silently. Without this, a buggy validator
 * just stops contributing to `errors` and the field reads as "valid" while
 * silently broken. With it, the throw is routed through `root.onError` as
 * `kind: 'effect'` AND the throw's message lands in the field's `errors`
 * array so the UI surfaces the problem.
 */
export type ValidatorErrorReporter = (err: unknown) => void

/**
 * When a field's validators are first allowed to run.
 *
 * - `'change'` (default) — validators run on every `set()`. Matches the
 *   current behavior, ideal for "type and see errors live."
 * - `'blur'` — first run is gated on `markTouched()`. After that, subsequent
 *   value changes do trigger re-validation. UI binding should call
 *   `markTouched()` on `onBlur`.
 * - `'submit'` — first run is gated on `revalidate()` / `Form.submit()`.
 *   After that, subsequent value changes re-validate. Use when you want
 *   "show errors only after the user explicitly tried to submit."
 *
 * `revalidate()` always unlocks the field regardless of mode.
 */
export type ValidateOn = 'change' | 'blur' | 'submit'

export type FieldImplOptions = {
  onValidatorError?: ValidatorErrorReporter
  validateOn?: ValidateOn
}

class FieldImpl<T> implements Field<T> {
  /** The value, boxed — see `Held`. Written only through `write`. */
  private readonly value$: Signal<Held<T>>
  /**
   * Validator-produced errors. The public `errors` getter merges this with
   * `serverErrors$` and `formErrors$` so consumers see a single flat array.
   * Kept separate so a re-run of validators (after a new value) doesn't clobber
   * the other two channels.
   */
  private readonly validatorErrors$: Signal<string[]>
  /**
   * Externally-injected errors — see `setErrors`. Cleared on the next user
   * `set()`, on `reset()`, or via an explicit `setErrors([])`.
   */
  private readonly serverErrors$: Signal<string[]>
  /**
   * Errors routed here by a parent (or ancestor) form-level validator that
   * targeted this field via a `FormIssue` path — the third error channel
   * beside validator + server errors (T5.2). One list per routing form, each
   * owned by its router: cleared and re-applied on every run of that form's
   * validators, and written by nothing else. So neither the field's `set()`
   * nor its `reset()` or `setAsInitial()` clears it. A write that changes the
   * value re-runs the form, which recomputes the channel. A no-op reset leaves
   * the form's value as it was, so the rule's last result still stands and
   * must stay visible.
   */
  private readonly formErrors = new RoutedErrors()
  private readonly errors$: Computed<string[]>
  private readonly touched$: Signal<boolean>
  private readonly dirty$: Signal<boolean>
  private readonly validating$: Signal<boolean>
  /**
   * Read-only views of the three writable signals above, built on first read
   * and then kept, so each member keeps one identity. The public members are
   * typed `ReadSignal`, and a cast must not reach `set` (§8.1).
   */
  private touchedView: ReadSignal<boolean> | null = null
  private dirtyView: ReadSignal<boolean> | null = null
  private validatingView: ReadSignal<boolean> | null = null
  private readonly isValid$: Computed<boolean>
  /**
   * Validity as of the last *settled* validation pass. While a pass is in
   * flight (`validating$`), `isValid` reads this instead of the live `errors`
   * — otherwise a `debouncedValidator` would flip `isValid` to `false` on every
   * keystroke (the async-start clears `validatorErrors$`), strobing a submit
   * button. Updated only when a pass completes (T5.3). Defaults `true` (an
   * untouched field with a pending first run reads valid, not invalid).
   */
  private readonly lastValid$: Signal<boolean>
  private readonly revalidateTrigger$: Signal<number>

  private readonly validators: ReadonlyArray<Validator<T>>
  /** Which validators count as async — see `asyncValidatorFlags`. */
  private readonly asyncValidators: boolean[]
  /** The value `reset()` returns to. Mutated by `setAsInitial()` so a form
   * initialized from server data resets to *that* data, not the empty seed.
   * Always the field's own `copyPlainData` copy: an edit of the value in
   * place, as a Svelte nested bind makes, must not reach it. */
  private initial: T
  private validatorDispose: (() => void) | null = null
  private currentAbort: AbortController | null = null
  private runId = 0
  private disposed = false
  private disposeHooks: Array<() => void> | null = null
  private devtoolsOwner: FieldDevtoolsOwner | null = null
  private onValidatorError: ValidatorErrorReporter | null = null
  private readonly validateOn: ValidateOn
  /** Reactive gate — when false, the validator effect skips its run. Flipped
   * on by the relevant trigger for the field's `validateOn` mode. Once on,
   * stays on for the lifetime of the field (matches RHF's `mode + reValidateMode`
   * default semantics: after the first activation, subsequent changes
   * re-validate). `reset()` flips it back to false. */
  private readonly validateUnlocked$: Signal<boolean>

  constructor(
    initial: T,
    validators: ReadonlyArray<Validator<T>> = [],
    options?: FieldImplOptions,
  ) {
    // The value is the object the caller passed; the baseline is a copy of it.
    this.initial = copyPlainData(initial)
    this.validators = validators
    this.asyncValidators = asyncValidatorFlags(validators)
    // Capture the reporter BEFORE the validator effect kicks off so a sync
    // throw on the very first pass routes through `onError` instead of
    // disappearing into the effect (`bindValidatorErrorReporter` is a
    // post-construct hook so it can't catch the first run).
    this.onValidatorError = options?.onValidatorError ?? null
    this.validateOn = options?.validateOn ?? 'change'
    this.value$ = signal<Held<T>>({ v: initial })
    this.validatorErrors$ = signal<string[]>([])
    this.serverErrors$ = signal<string[]>([])
    this.touched$ = signal(false)
    this.dirty$ = signal(false)
    this.validating$ = signal(false)
    this.lastValid$ = signal(true)
    this.revalidateTrigger$ = signal(0)
    // 'change' mode is unlocked from construction; 'blur' / 'submit' wait
    // for their trigger so initial typing doesn't surface errors.
    this.validateUnlocked$ = signal(this.validateOn === 'change')
    this.errors$ = computed(() => {
      const v = this.validatorErrors$.value
      const s = this.serverErrors$.value
      const f = this.formErrors.merged.value
      if (s.length === 0 && f.length === 0) return v
      if (v.length === 0 && f.length === 0) return s
      if (v.length === 0 && s.length === 0) return f
      return [...v, ...s, ...f]
    })
    this.isValid$ = computed(() =>
      // While a validation pass is in flight, hold the last settled validity so
      // the field doesn't strobe invalid mid-check (T5.3). Otherwise it's live.
      this.validating$.value ? this.lastValid$.value : this.errors$.value.length === 0,
    )

    if (validators.length > 0) {
      this.validatorDispose = effect(() => {
        this.runValidators()
      })
    }
  }

  /**
   * Internal hook for `createField` / `createForm` to route synchronous
   * validator throws through `root.onError`. See `ValidatorErrorReporter`.
   */
  bindValidatorErrorReporter(reporter: ValidatorErrorReporter | null): void {
    this.onValidatorError = reporter
  }

  // --- ReadSignal<T> ---
  get value(): T {
    return this.value$.value.v
  }

  peek(): T {
    return this.value$.peek().v
  }

  subscribe(handler: (value: T) => void): () => void {
    return this.value$.subscribe((held) => handler(held.v))
  }

  subscribeChanges(handler: (value: T) => void): () => void {
    return this.value$.subscribeChanges((held) => handler(held.v))
  }

  /**
   * Store `value`. A primitive equal to the current one (`Object.is`) is no
   * change and writes nothing. The object the field already holds is a
   * change when `sameObjectCounts` is set, which only `set` passes.
   */
  private write(value: T, sameObjectCounts: boolean): void {
    if (Object.is(this.value$.peek().v, value)) {
      const isObject = (typeof value === 'object' && value !== null) || typeof value === 'function'
      if (!sameObjectCounts || !isObject) return
    }
    this.value$.set({ v: value })
  }

  // --- Field-only signals ---
  get errors(): ReadSignal<string[]> {
    return this.errors$
  }

  get isValid(): ReadSignal<boolean> {
    return this.isValid$
  }

  get isDirty(): ReadSignal<boolean> {
    if (this.dirtyView === null) this.dirtyView = readOnly(this.dirty$)
    return this.dirtyView
  }

  get touched(): ReadSignal<boolean> {
    if (this.touchedView === null) this.touchedView = readOnly(this.touched$)
    return this.touchedView
  }

  get isValidating(): ReadSignal<boolean> {
    if (this.validatingView === null) this.validatingView = readOnly(this.validating$)
    return this.validatingView
  }

  // --- mutating methods ---
  // Arrow-bound so `set` survives being passed as a value — `onChange={field.set}`
  // or `setName: field.set` — instead of throwing once detached from the field.
  set = (value: T): void => {
    if (this.disposed) return
    batch(() => {
      // A `set` of the object the field already holds is a change, as it is
      // to a Svelte store (`safe_not_equal`). Svelte writes a nested bind,
      // `bind:value={$person.first}`, by assigning the member on this very
      // object and then calling `set` with it. So validators re-run,
      // subscribers hear it, and dirty is recomputed below. A primitive equal
      // to the current one stays no change (spec §8.1).
      this.write(value, true)
      // Equality-aware dirty: setting back to initial clears dirty, so
      // "Disable Save when unchanged" UIs work without consumer code. Uses
      // a structural comparison for primitive / shallow-object / array
      // payloads; falls back to reference identity for class instances.
      this.dirty$.set(!isStructurallyEqual(value, this.initial))
      // Server errors are pinned externally and survive validator re-runs,
      // but they MUST clear when the user edits the field — otherwise a
      // server error like "username taken" would persist after the user
      // typed a different username.
      if (this.serverErrors$.peek().length > 0) this.serverErrors$.set([])
    })
  }

  setErrors(errors: ReadonlyArray<string>): void {
    if (this.disposed) return
    const next = errors.length === 0 ? [] : [...errors]
    this.serverErrors$.set(next)
  }

  /**
   * Internal — set `source`'s list in the parent-form-validator error channel.
   * Called by a form's issue router when a `FormIssue` path resolves to this
   * field; `source` is that routing form. See T5.2 / `routeFormIssues` in
   * `form.ts`.
   */
  setFormErrors(errors: ReadonlyArray<string>, source: object): void {
    if (this.disposed) return
    this.formErrors.set(source, errors)
  }

  /**
   * Reseat the field as if this value had been its constructor `initial`.
   * Sets the value, re-anchors `reset()`'s target, and does NOT mark dirty.
   * Used by `Form` when applying its own `initial` (in the constructor and
   * on `reset()`), so server-loaded forms don't start dirty. Internal-ish —
   * exposed for `Form`'s use, not for user code that just wants to write.
   */
  setAsInitial(value: T): void {
    if (this.disposed) return
    this.initial = copyPlainData(value)
    batch(() => {
      // The same object again is no change here: a reactive `initial()` that
      // hands back the objects it handed out before re-seats nothing.
      this.write(value, false)
      this.dirty$.set(false)
      // Re-seating from a fresh server payload means the previous server
      // response is no longer relevant. Without clearing, errors like
      // "username taken" persist across a successful re-hydrate.
      if (this.serverErrors$.peek().length > 0) this.serverErrors$.set([])
      // `formErrors` stays: the routing forms own it. A new value re-runs the
      // forms, which recompute it; the same value leaves their rules' results
      // standing.
    })
  }

  /**
   * Internal — move `reset()`'s target to `value` and keep the current value.
   * `isDirty` then compares against the new baseline. `Form` calls it for the
   * first `initial()` value on a field the user already edited (§8.4), so the
   * edit stays and a later `reset()` returns to the loaded data.
   */
  rebaseInitial(value: T): void {
    if (this.disposed) return
    this.initial = copyPlainData(value)
    this.dirty$.set(!isStructurallyEqual(this.value$.peek().v, value))
  }

  reset(): void {
    if (this.disposed) return
    this.currentAbort?.abort()
    this.currentAbort = null
    // Retire the pass in flight. A validator that ignores its AbortSignal
    // still resolves, and its result must not land on the reset field.
    this.runId++
    // A value that already matches the baseline stays as it is: no write, so
    // the validator effect does not wake, and the sync pass below stands in.
    // Otherwise the field takes a fresh copy of the baseline, never the
    // baseline itself, so a later in-place edit cannot reach it.
    const unchanged = isStructurallyEqual(this.value$.peek().v, this.initial)
    batch(() => {
      if (!unchanged) this.write(copyPlainData(this.initial), false)
      this.dirty$.set(false)
      this.touched$.set(false)
      this.validatorErrors$.set([])
      this.serverErrors$.set([])
      // Not `formErrors`: the routing forms own it (see its declaration).
      this.validating$.set(false)
      // Re-lock validation if the field was in blur/submit mode — a reset
      // means we're back to a clean slate, so the user shouldn't immediately
      // see errors again until they re-trigger.
      if (this.validateOn !== 'change') this.validateUnlocked$.set(false)
      // A reset leaves the field as a fresh one with this value would be. A
      // changed value re-runs the effect, which runs every validator. An
      // unchanged one does not, so the sync validators re-run here: a pristine
      // `required()` field still reads invalid. The async ones do not. A reset
      // drops the check in flight (§8.1), and re-sending a request for a value
      // the user did not change is a cost a reset should not add. `revalidate()`,
      // `validate()` and `submit()` re-run them.
      else if (unchanged && this.validatorDispose !== null) {
        untracked(() => this.runValidators(true))
      }
    })
  }

  markTouched(): void {
    if (this.disposed) return
    this.touched$.set(true)
    // 'blur' mode unlocks validation on first blur. Subsequent set() calls
    // then re-validate live (matches RHF `reValidateMode: onChange` default).
    if (this.validateOn === 'blur' && !this.validateUnlocked$.peek()) {
      this.validateUnlocked$.set(true)
    }
  }

  async revalidate(): Promise<boolean> {
    if (this.disposed) return this.isValid$.peek()
    // `revalidate()` always unlocks the field — same trigger as a successful
    // submit attempt. 'submit' mode uses this as its first activation.
    if (!this.validateUnlocked$.peek()) this.validateUnlocked$.set(true)
    // Bump the trigger to force re-run.
    const before = this.runId
    this.revalidateTrigger$.update((n) => n + 1)
    // Inside a `batch()` or an effect, the validator effect runs when that
    // ends, not here, so `validating$` still reads the previous pass. A
    // microtask later the batch has flushed and the pass this call asked for
    // has started, so the wait below sees it. `submit()` validates first in
    // every calling context this way (§8.6).
    if (this.validatorDispose !== null && this.runId === before) await Promise.resolve()
    await this.waitUntilSettled()
    return this.isValid$.peek()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.validatorDispose?.()
    this.validatorDispose = null
    this.currentAbort?.abort()
    this.currentAbort = null
    this.devtoolsOwner = null
    // A pass in flight never settles now: its result is dropped. End it here,
    // so a `revalidate()`, `validate()` or `submit()` waiting on it resolves.
    // A row removed from a field array mid-submit otherwise hung the submit.
    this.validating$.set(false)
    const hooks = this.disposeHooks
    this.disposeHooks = null
    runDisposeHooks(hooks)
  }

  /** Internal — see `addNodeDisposeHook`. */
  addDisposeHook(fn: () => void): void {
    if (this.disposed) {
      fn()
      return
    }
    if (this.disposeHooks === null) this.disposeHooks = []
    this.disposeHooks.push(fn)
  }

  /**
   * Bind this field to a devtools owner. Each subsequent validation pass
   * publishes a `field:validated` event with the supplied path + name.
   * Idempotent — calling again replaces the owner. Internal: called by
   * `createForm` / `createFieldArray` so the form's keys reach the panel.
   */
  bindDevtoolsOwner(owner: FieldDevtoolsOwner | null): void {
    this.devtoolsOwner = owner
  }

  private emitValidated(valid: boolean, errors: readonly string[]): void {
    if (!__DEV__) return
    const owner = this.devtoolsOwner
    if (owner === null) return
    owner.emitter.emit({
      type: 'field:validated',
      path: owner.controllerPath,
      field: owner.fieldName,
      valid,
      errors: [...errors],
    })
  }

  // --- internal ---
  private async waitUntilSettled(): Promise<void> {
    // If a validation pass is in progress, wait for validating$ to become false.
    if (!this.validating$.peek()) return
    await new Promise<void>((resolve) => {
      const unsub = this.validating$.subscribe((v) => {
        if (!v) {
          unsub()
          resolve()
        }
      })
    })
  }

  /**
   * One validation pass. The effect runs it with every validator. `reset()`
   * runs it with `syncOnly`, which calls no async validator and abandons a
   * promise one returns.
   */
  private runValidators(syncOnly = false): void {
    if (this.disposed) return

    // Track value and revalidate trigger.
    const value = this.value$.value.v
    void this.revalidateTrigger$.value
    // Track the gate so the effect re-runs when the field becomes unlocked.
    // While locked, skip the pass entirely — errors stay empty, the field
    // reads as valid, no async work starts.
    if (!this.validateUnlocked$.value) {
      // Retire any pass still in flight, as `reset()` does, so its result
      // cannot land on the locked field.
      this.runId++
      batch(() => {
        if (this.validatorErrors$.peek().length > 0) this.validatorErrors$.set([])
        if (this.validating$.peek()) this.validating$.set(false)
        this.lastValid$.set(this.errors$.peek().length === 0)
      })
      return
    }

    // Abort previous in-flight run.
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort
    const myId = ++this.runId

    const syncErrors: string[] = []
    // Sync validators first; the async ones start only when every sync one
    // passed (spec §8.1).
    const { failed, pending: asyncPromises } = callValidators(
      this.validators,
      this.asyncValidators,
      value,
      abort.signal,
      (result) => {
        // A Standard-Schema validator returns `FormIssue[]`; a stdlib one
        // returns `string | null`. Flatten both to messages (a leaf field has
        // no descendants to route issue paths to).
        const msgs = messagesFromResult(result)
        if (msgs.length === 0) return false
        syncErrors.push(...msgs)
        return true
      },
      (err) => {
        // A buggy validator that throws synchronously: surface it twice.
        // (1) Route through `onError` so the developer knows something is wrong.
        // (2) Mark the field invalid until the bug is fixed (don't pretend OK).
        // In prod the user-visible message is generic — leaking an internal
        // error's text into form errors is a footgun; the real error still
        // reaches `onValidatorError` (T5.3). Dev keeps the message for DX.
        try {
          this.onValidatorError?.(err)
        } catch {
          // The reporter must not propagate.
        }
        syncErrors.push(thrownMessage(err))
      },
      syncOnly,
    )

    if (failed) {
      abandonAsyncResults(asyncPromises, abort)
      batch(() => {
        this.validatorErrors$.set(syncErrors)
        this.validating$.set(false)
        this.lastValid$.set(this.errors$.peek().length === 0)
      })
      this.emitValidated(false, syncErrors)
      return
    }

    if (syncOnly) abandonAsyncResults(asyncPromises, abort)
    if (asyncPromises.length === 0 || syncOnly) {
      batch(() => {
        this.validatorErrors$.set([])
        this.validating$.set(false)
        this.lastValid$.set(this.errors$.peek().length === 0)
      })
      this.emitValidated(true, [])
      return
    }

    batch(() => {
      this.validatorErrors$.set([])
      this.validating$.set(true)
    })

    Promise.allSettled(asyncPromises).then((results) => {
      if (myId !== this.runId || this.disposed) return
      const asyncErrors: string[] = []
      for (const r of results) {
        if (r.status === 'fulfilled') {
          asyncErrors.push(...messagesFromResult(r.value))
        } else {
          const msg = rejectionMessage(r.reason, (err) => this.onValidatorError?.(err))
          if (msg !== null) asyncErrors.push(msg)
        }
      }
      batch(() => {
        this.validatorErrors$.set(asyncErrors)
        this.validating$.set(false)
        this.lastValid$.set(this.errors$.peek().length === 0)
      })
      this.emitValidated(asyncErrors.length === 0, asyncErrors)
    })
  }
}

/**
 * Internal — type guard / accessor for the binding hook. Avoids exposing
 * `bindDevtoolsOwner` on the public `Field<T>` type while letting `createForm`
 * call it via a structural check.
 */
export function bindFieldDevtoolsOwner<T>(field: Field<T>, owner: FieldDevtoolsOwner | null): void {
  const impl = field as { bindDevtoolsOwner?: (o: FieldDevtoolsOwner | null) => void }
  if (typeof impl.bindDevtoolsOwner === 'function') {
    impl.bindDevtoolsOwner(owner)
  }
}

/**
 * Internal — install a synchronous-validator-throw reporter on a `Field`
 * (matched structurally to keep the public `Field<T>` surface stable).
 * Called by `createField` and `bindTreeToDevtools` so leaves inside a form/
 * field-array tree get the same reporting as a standalone field.
 */
export function bindFieldValidatorErrorReporter<T>(
  field: Field<T>,
  reporter: ValidatorErrorReporter | null,
): void {
  const impl = field as { bindValidatorErrorReporter?: (r: ValidatorErrorReporter | null) => void }
  if (typeof impl.bindValidatorErrorReporter === 'function') {
    impl.bindValidatorErrorReporter(reporter)
  }
}

export function createField<T>(
  initial: T,
  validators?: ReadonlyArray<Validator<T>>,
  options?: FieldImplOptions,
): Field<T> {
  return new FieldImpl(initial, validators, options)
}

/**
 * A bidirectional `T ↔ string` transform, suitable for HTML input bindings
 * where DOM values are always strings.
 *
 * `parse(raw)` converts the input's string value into the field's type;
 * `format(value)` converts the field's typed value back into a string for
 * the input. Both must be pure — `useFieldInput` calls them on every
 * render and every input event respectively.
 *
 * ```ts
 * const numberTransform: FieldTransform<number> = {
 *   parse: (raw) => Number(raw),
 *   format: (v) => String(v),
 * }
 * ```
 */
export type FieldTransform<T> = {
  parse: (raw: string) => T
  format: (value: T) => string
}

/**
 * Wrap an async validator with a debounce. The debounce timer resets on every
 * value change. While debouncing or the request is in flight, the field's
 * `isValidating` is true and `isValid` HOLDS its last settled value (T5.3) — so
 * editing an already-valid field doesn't strobe a submit button to disabled on
 * every keystroke. A field with no prior settled validation defaults to valid.
 *
 * A `fn` that throws synchronously, or returns no promise, fails the pass the
 * way a sync validator that throws does: the message shows on the field and
 * the error reaches `onError`. The pass settles either way.
 */
export function debouncedValidator<T>(
  fn: (value: T, signal: AbortSignal) => Promise<string | null>,
  ms: number,
): (value: T, signal: AbortSignal) => Promise<string | null> {
  // Precise return (not the wide `Validator<T>`): the wrapped `fn` only ever
  // yields `string | null`, so callers that invoke the debounced validator
  // directly — e.g. surfacing its result in a signal — keep that narrow type
  // after `Validator<T>` was widened to allow `FormIssue[]` (T5.2). Still
  // assignable wherever a `Validator<T>` is expected.
  return (value, signal) =>
    new Promise<string | null>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        // A throw here would escape the timer and leave this promise pending,
        // and the field validating for good.
        let result: unknown
        try {
          result = fn(value, signal)
        } catch (err) {
          reject(markValidatorBug(err))
          return
        }
        if (isThenable(result)) {
          ;(result as PromiseLike<string | null>).then(resolve, reject)
        } else {
          reject(
            markValidatorBug(new TypeError('[olas] debouncedValidator: fn must return a promise')),
          )
        }
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
}
