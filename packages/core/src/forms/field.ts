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
} from '../signals'
import { isAbortError } from '../utils'
import type { Validator } from './types'

/**
 * Structural equality used by `Field.set` to decide whether a write returns
 * the field to its initial value (clearing `isDirty`). Cheap path for
 * primitives + `Object.is`; deep walk for arrays and plain objects. Class
 * instances, Map, Set, Date fall back to reference identity — same trade-off
 * `structural-share.ts` makes for cache data.
 */
function isStructurallyEqual(a: unknown, b: unknown): boolean {
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

/**
 * Hook attached by `ctx.form` (or `createForm`) so a Field can publish
 * `field:validated` devtools events with its owning controller path + the
 * field's name within the form schema. See devtools §20.9 and FieldImpl.bind.
 */
export type FieldDevtoolsOwner = {
  controllerPath: readonly string[]
  fieldName: string
  emitter: DevtoolsEmitter
}

/**
 * Optional reporter for synchronous validator throws — wired in by `ctx.field`
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

export type FieldOptions = {
  onValidatorError?: ValidatorErrorReporter
  validateOn?: ValidateOn
}

class FieldImpl<T> implements Field<T> {
  private readonly value$: Signal<T>
  /**
   * Validator-produced errors. The public `errors` getter merges this with
   * `serverErrors$` so consumers see a single flat array. Kept separate so a
   * re-run of validators (after a new value) doesn't clobber server errors.
   */
  private readonly validatorErrors$: Signal<string[]>
  /**
   * Externally-injected errors — see `setErrors`. Cleared on the next user
   * `set()`, on `reset()`, or via an explicit `setErrors([])`.
   */
  private readonly serverErrors$: Signal<string[]>
  private readonly errors$: Computed<string[]>
  private readonly touched$: Signal<boolean>
  private readonly dirty$: Signal<boolean>
  private readonly validating$: Signal<boolean>
  private readonly isValid$: Computed<boolean>
  private readonly revalidateTrigger$: Signal<number>

  private readonly validators: ReadonlyArray<Validator<T>>
  /** The value `reset()` returns to. Mutated by `setAsInitial()` so a form
   * initialized from server data resets to *that* data, not the empty seed. */
  private initial: T
  private validatorDispose: (() => void) | null = null
  private currentAbort: AbortController | null = null
  private runId = 0
  private disposed = false
  private devtoolsOwner: FieldDevtoolsOwner | null = null
  private onValidatorError: ValidatorErrorReporter | null = null
  private readonly validateOn: ValidateOn
  /** Reactive gate — when false, the validator effect skips its run. Flipped
   * on by the relevant trigger for the field's `validateOn` mode. Once on,
   * stays on for the lifetime of the field (matches RHF's `mode + reValidateMode`
   * default semantics: after the first activation, subsequent changes
   * re-validate). `reset()` flips it back to false. */
  private readonly validateUnlocked$: Signal<boolean>

  constructor(initial: T, validators: ReadonlyArray<Validator<T>> = [], options?: FieldOptions) {
    this.initial = initial
    this.validators = validators
    // Capture the reporter BEFORE the validator effect kicks off so a sync
    // throw on the very first pass routes through `onError` instead of
    // disappearing into the effect (`bindValidatorErrorReporter` is a
    // post-construct hook so it can't catch the first run).
    this.onValidatorError = options?.onValidatorError ?? null
    this.validateOn = options?.validateOn ?? 'change'
    this.value$ = signal(initial)
    this.validatorErrors$ = signal<string[]>([])
    this.serverErrors$ = signal<string[]>([])
    this.touched$ = signal(false)
    this.dirty$ = signal(false)
    this.validating$ = signal(false)
    this.revalidateTrigger$ = signal(0)
    // 'change' mode is unlocked from construction; 'blur' / 'submit' wait
    // for their trigger so initial typing doesn't surface errors.
    this.validateUnlocked$ = signal(this.validateOn === 'change')
    this.errors$ = computed(() => {
      const v = this.validatorErrors$.value
      const s = this.serverErrors$.value
      if (s.length === 0) return v
      if (v.length === 0) return s
      return [...v, ...s]
    })
    this.isValid$ = computed(() => this.errors$.value.length === 0 && !this.validating$.value)

    if (validators.length > 0) {
      this.validatorDispose = effect(() => {
        this.runValidators()
      })
    }
  }

  /**
   * Internal hook for `ctx.field` / `createForm` to route synchronous
   * validator throws through `root.onError`. See `ValidatorErrorReporter`.
   */
  bindValidatorErrorReporter(reporter: ValidatorErrorReporter | null): void {
    this.onValidatorError = reporter
  }

  // --- ReadSignal<T> ---
  get value(): T {
    return this.value$.value
  }

  peek(): T {
    return this.value$.peek()
  }

  subscribe(handler: (value: T) => void): () => void {
    return this.value$.subscribe(handler)
  }

  subscribeChanges(handler: (value: T) => void): () => void {
    return this.value$.subscribeChanges(handler)
  }

  // --- Field-only signals ---
  get errors(): ReadSignal<string[]> {
    return this.errors$
  }

  get isValid(): ReadSignal<boolean> {
    return this.isValid$
  }

  get isDirty(): ReadSignal<boolean> {
    return this.dirty$
  }

  get touched(): ReadSignal<boolean> {
    return this.touched$
  }

  get isValidating(): ReadSignal<boolean> {
    return this.validating$
  }

  // --- mutating methods ---
  set(value: T): void {
    if (this.disposed) return
    batch(() => {
      this.value$.set(value)
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
   * Reseat the field as if this value had been its constructor `initial`.
   * Sets the value, re-anchors `reset()`'s target, and does NOT mark dirty.
   * Used by `Form` when applying its own `initial` (in the constructor and
   * on `reset()`), so server-loaded forms don't start dirty. Internal-ish —
   * exposed for `Form`'s use, not for user code that just wants to write.
   */
  setAsInitial(value: T): void {
    if (this.disposed) return
    this.initial = value
    batch(() => {
      this.value$.set(value)
      this.dirty$.set(false)
      // Re-seating from a fresh server payload means the previous server
      // response is no longer relevant. Without clearing, errors like
      // "username taken" persist across a successful re-hydrate.
      if (this.serverErrors$.peek().length > 0) this.serverErrors$.set([])
    })
  }

  reset(): void {
    if (this.disposed) return
    this.currentAbort?.abort()
    this.currentAbort = null
    batch(() => {
      this.value$.set(this.initial)
      this.dirty$.set(false)
      this.touched$.set(false)
      this.validatorErrors$.set([])
      this.serverErrors$.set([])
      this.validating$.set(false)
      // Re-lock validation if the field was in blur/submit mode — a reset
      // means we're back to a clean slate, so the user shouldn't immediately
      // see errors again until they re-trigger.
      if (this.validateOn !== 'change') this.validateUnlocked$.set(false)
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
    this.revalidateTrigger$.update((n) => n + 1)
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

  private runValidators(): void {
    if (this.disposed) return

    // Track value and revalidate trigger.
    const value = this.value$.value
    void this.revalidateTrigger$.value
    // Track the gate so the effect re-runs when the field becomes unlocked.
    // While locked, skip the pass entirely — errors stay empty, the field
    // reads as valid, no async work starts.
    if (!this.validateUnlocked$.value) {
      batch(() => {
        if (this.validatorErrors$.peek().length > 0) this.validatorErrors$.set([])
        if (this.validating$.peek()) this.validating$.set(false)
      })
      return
    }

    // Abort previous in-flight run.
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort
    const myId = ++this.runId

    const syncErrors: string[] = []
    const asyncPromises: Promise<string | null>[] = []

    for (const validator of this.validators) {
      try {
        const result = validator(value, abort.signal)
        if (result instanceof Promise) {
          // Defend against the validator promise rejecting *synchronously*
          // with a thrown error (rare but legal) — the catch-handler in
          // `Promise.allSettled` covers true async rejection.
          asyncPromises.push(result)
        } else if (result != null) {
          syncErrors.push(result)
        }
      } catch (err) {
        // A buggy validator that throws synchronously: surface it twice.
        // (1) Route through `onError` so the user knows something is wrong.
        // (2) Convert to a validation error string so the field reads invalid
        //     until the bug is fixed (don't pretend everything's OK).
        try {
          this.onValidatorError?.(err)
        } catch {
          // The reporter must not propagate.
        }
        syncErrors.push(err instanceof Error ? err.message : String(err))
      }
    }

    if (syncErrors.length > 0) {
      batch(() => {
        this.validatorErrors$.set(syncErrors)
        this.validating$.set(false)
      })
      this.emitValidated(false, syncErrors)
      return
    }

    if (asyncPromises.length === 0) {
      batch(() => {
        this.validatorErrors$.set([])
        this.validating$.set(false)
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
          if (r.value != null) asyncErrors.push(r.value)
        } else if (!isAbortError(r.reason)) {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
          asyncErrors.push(msg)
        }
      }
      batch(() => {
        this.validatorErrors$.set(asyncErrors)
        this.validating$.set(false)
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
 * Called by `ctx.field` and `bindTreeToDevtools` so leaves inside a form/
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
  options?: FieldOptions,
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
 * `isValidating` is true and `isValid` is false (treat-as-invalid-until-proven-valid).
 */
export function debouncedValidator<T>(
  fn: (value: T, signal: AbortSignal) => Promise<string | null>,
  ms: number,
): Validator<T> {
  return (value, signal) =>
    new Promise<string | null>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        fn(value, signal).then(resolve, reject)
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
}
