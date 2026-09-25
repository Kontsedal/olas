import type { Field } from '../controller/types'
import { batch, computed, effect, type Signal, signal, untracked } from '../signals'
import { readOnly } from '../signals/readonly'
import type { ReadSignal } from '../signals/types'
import { abandonAsyncResults } from '../utils'
import {
  asyncValidatorFlags,
  bindFieldDevtoolsOwner,
  bindFieldValidatorErrorReporter,
  callValidators,
  copyPlainData,
  RoutedErrors,
  rejectionMessage,
  runDisposeHooks,
  thrownMessage,
  type ValidatorErrorReporter,
} from './field'
import type {
  DeepPartial,
  FieldArray,
  FieldArrayItemErrors,
  FieldArrayOptions,
  FieldArrayValidator,
  FieldArrayValue,
  Form,
  FormErrors,
  FormOptions,
  FormSchema,
  FormValidator,
  FormValue,
  ItemInitial,
  SubmitOptions,
  SubmitResult,
} from './form-types'
import type { FormIssue, Validator, ValidatorResult } from './types'

const FORM_BRAND = Symbol.for('olas.form')
const FIELD_ARRAY_BRAND = Symbol.for('olas.fieldArray')

const brand = (node: object, key: symbol): void => {
  ;(node as Record<symbol, unknown>)[key] = true
}

/**
 * Messages `setErrors` pinned on a form or field array itself, with the value
 * the node held then. They show while the node still holds that value, so the
 * next change anywhere in it clears them, as a field's next `set()` clears its
 * own. A form's value and an array's value are computeds that build a new
 * object on every change, so "the same value" means the same object.
 */
type PinnedErrors = { errors: string[]; against: unknown }

/** The pinned messages that still apply to a node now holding `value`. */
function pinnedFor(pinned: PinnedErrors | null, value: () => unknown): string[] {
  if (pinned === null) return []
  return value() === pinned.against ? pinned.errors : []
}

/** `own`, then each non-empty list after it, keeping `own` when nothing adds. */
function mergeErrors(own: string[], ...more: string[][]): string[] {
  const extra = more.filter((list) => list.length > 0)
  if (extra.length === 0) return own
  if (own.length === 0 && extra.length === 1) return extra[0] as string[]
  return [...own, ...extra.flat()]
}

/**
 * `isValid` for an aggregate node: the live answer when nothing below it is
 * validating, and the last settled answer while something is. An effect keeps
 * the settled answer current even when nothing reads `isValid`.
 */
function holdWhileValidating(
  isValidating: ReadSignal<boolean>,
  live: ReadSignal<boolean>,
  keepStop: (stop: () => void) => void,
): ReadSignal<boolean> {
  const settled = signal(true)
  keepStop(
    effect(() => {
      if (!isValidating.value) settled.set(live.value)
    }),
  )
  return computed(() => (isValidating.value ? settled.value : live.value))
}

/**
 * What `FormImpl.seatKeepingEdits` needs of a child. Fields and field arrays
 * built by core have `rebaseInitial`, and forms have `seatKeepingEdits`.
 */
type SeatTarget = {
  readonly isDirty: ReadSignal<boolean>
  setAsInitial(value: unknown): void
  seatKeepingEdits?: (value: unknown) => void
  rebaseInitial?: (value: unknown) => void
}

const isForm = (x: unknown): x is Form<FormSchema> =>
  typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[FORM_BRAND] === true

const isFieldArray = (x: unknown): x is FieldArray<Field<unknown> | Form<FormSchema>> =>
  typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[FIELD_ARRAY_BRAND] === true

/** A field, as opposed to a nested form or field array. */
const isLeaf = (x: unknown): boolean => !isForm(x) && !isFieldArray(x)

/**
 * Any node that can receive parent-form-validator-routed errors (T5.2).
 * `source` is the routing node, so each router keeps its own list.
 */
type FormErrorTarget = { setFormErrors?: (msgs: ReadonlyArray<string>, source: object) => void }

/**
 * Walk a form tree from `root` following `FormIssue.path` segments. Forms walk
 * keys; field-arrays walk numeric indices. Returns the resolved node, or
 * `undefined` if the path runs off the tree (bad index, or a leaf reached with
 * an unconsumed path segment). Reads are untracked (`fields` is a static object;
 * `at()` peeks) so calling this inside a validator effect adds no dependencies.
 */
function resolveNode(root: unknown, segments: ReadonlyArray<string | number>): unknown {
  let cursor: unknown = root
  for (const seg of segments) {
    if (cursor === undefined || cursor === null) return undefined
    if (isForm(cursor)) {
      cursor = (cursor.fields as Record<string, unknown>)[String(seg)]
    } else if (isFieldArray(cursor)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0) return undefined
      cursor = (cursor as { at(i: number): unknown }).at(idx)
    } else {
      return undefined
    }
  }
  return cursor
}

/**
 * Normalize one validator result into the shared `FormIssue[]` shape. A plain
 * string is a message on the node itself (empty path); `null` contributes
 * nothing; a `FormIssue[]` is appended verbatim.
 */
function appendIssues(out: FormIssue[], result: ValidatorResult): void {
  if (result == null) return
  if (typeof result === 'string') {
    out.push({ path: [], message: result })
    return
  }
  for (const issue of result) out.push(issue)
}

/**
 * One form-level or array-level pass, sync validators first (spec §8.1) —
 * see `callValidators`. Collects the synchronous issues. A synchronous throw
 * reaches `report` and becomes an issue on the node itself. Prod shows a
 * generic message for it, so internal error text does not leak into form
 * errors; the real error still reaches `report` (T5.3).
 */
function runLevelValidators<V>(
  validators: ReadonlyArray<Validator<V>>,
  isAsync: boolean[],
  value: V,
  signal: AbortSignal,
  report: (err: unknown) => void,
): { issues: FormIssue[]; failed: boolean; pending: Promise<ValidatorResult>[] } {
  const issues: FormIssue[] = []
  const { failed, pending } = callValidators(
    validators,
    isAsync,
    value,
    signal,
    (result) => {
      const before = issues.length
      appendIssues(issues, result)
      return issues.length > before
    },
    (err) => {
      report(err)
      issues.push({ path: [], message: thrownMessage(err) })
    },
  )
  return { issues, failed, pending }
}

/**
 * Route a fully-collected issue set for one form-level validation run:
 *  - empty-path (and unresolvable) issues → `topLevelErrors$` on the owning node
 *  - path issues → the resolved descendant's `setFormErrors`, under `root`
 *
 * Targets that received an error last run but not this one are cleared, so a
 * fixed cross-field rule removes its message from the field it landed on. The
 * clear removes only `root`'s list: another router's messages on the same
 * target stay. Returns the new target set for the caller to retain. MUST run
 * inside a batch.
 */
function routeFormIssues(
  root: object,
  issues: FormIssue[],
  topLevelErrors$: Signal<string[]>,
  lastTargets: Set<FormErrorTarget>,
): Set<FormErrorTarget> {
  const topLevel: string[] = []
  const byTarget = new Map<FormErrorTarget, string[]>()
  for (const issue of issues) {
    if (issue.path.length === 0) {
      topLevel.push(issue.message)
      continue
    }
    const target = resolveNode(root, issue.path) as FormErrorTarget | undefined
    if (target === undefined || typeof target.setFormErrors !== 'function') {
      // Unresolvable path — surface at the top level rather than dropping it.
      topLevel.push(issue.message)
      continue
    }
    const list = byTarget.get(target)
    if (list) list.push(issue.message)
    else byTarget.set(target, [issue.message])
  }
  topLevelErrors$.set(topLevel)
  for (const t of lastTargets) {
    if (!byTarget.has(t)) t.setFormErrors?.([], root)
  }
  for (const [t, msgs] of byTarget) t.setFormErrors?.(msgs, root)
  return new Set(byTarget.keys())
}

class FormImpl<S extends FormSchema> implements Form<S> {
  readonly fields: S
  private readonly value$: ReadSignal<FormValue<S>>
  readonly errors: ReadSignal<FormErrors<S>>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly flatErrors: ReadSignal<Array<{ path: string; errors: string[] }>>
  /**
   * Dotted paths of every leaf whose `isDirty` is `true`, and of every field
   * array changed structurally (see `collectDirtyFields`). Recomputes when
   * any child's dirty state flips; ordered by depth-first traversal. Useful
   * for partial-update PATCH payloads and "highlight the changed inputs" UIs.
   */
  readonly dirtyFields: ReadSignal<string[]>

  private readonly topLevelErrors$: Signal<string[]> = signal([])
  /**
   * Errors routed to THIS form by ancestor form-level validators (a
   * `FormIssue` whose path resolves to this node), one list per ancestor.
   * Merged into `topLevelErrors` beside this form's own validator output, so
   * `topLevelErrors` means "errors attached to this node itself, whatever their
   * source". Each list is owned by its router (T5.2) — see `setFormErrors`.
   */
  private readonly parentFormErrors = new RoutedErrors()
  /** `setErrors` messages on this form itself — see `PinnedErrors`. */
  private readonly serverErrors$: Signal<PinnedErrors | null> = signal(null)
  readonly topLevelErrors: ReadSignal<string[]> = computed(() =>
    mergeErrors(
      this.topLevelErrors$.value,
      pinnedFor(this.serverErrors$.value, () => this.value$.value),
      this.parentFormErrors.merged.value,
    ),
  )
  private readonly topLevelValidating$: Signal<boolean> = signal(false)
  /** Targets written by the last form-level run — cleared next run if absent. */
  private lastFormErrorTargets: Set<FormErrorTarget> = new Set()

  // Submission lifecycle. The public members are read-only views, so a cast
  // of the `ReadSignal` type cannot reach `set` (§8.6).
  private readonly isSubmitting$: Signal<boolean> = signal(false)
  private readonly submitCount$: Signal<number> = signal(0)
  private readonly submitError$: Signal<unknown> = signal(undefined)
  readonly isSubmitting: ReadSignal<boolean> = readOnly(this.isSubmitting$)
  readonly submitCount: ReadSignal<number> = readOnly(this.submitCount$)
  readonly submitError: ReadSignal<unknown> = readOnly(this.submitError$)

  private readonly validators: ReadonlyArray<FormValidator<S>>
  /** Which top-level validators count as async — see `asyncValidatorFlags`. */
  private readonly asyncValidators: boolean[]
  private readonly options: FormOptions<S> | undefined
  /**
   * The form's own copy of a fixed `initial` object, which `reset()` re-seats
   * from. The fields hold the caller's objects after construction, and a
   * Svelte nested bind on one edits it in place; the copy keeps `reset()`
   * whole (spec §16.3).
   */
  private readonly staticInitial: DeepPartial<FormValue<S>> | undefined
  private validatorDispose: (() => void) | null = null
  private validityDispose: (() => void) | null = null
  private initialDispose: (() => void) | null = null
  /**
   * Set once a defined `initial()` value has been seated, by the reactive
   * effect or by `reset()`. The next value is no longer the first (§8.4).
   */
  private initialSeated = false
  private currentValidatorRun = 0
  private currentValidatorAbort: AbortController | null = null
  private disposed = false
  private disposeHooks: Array<() => void> | null = null
  private onValidatorError: ((err: unknown) => void) | null = null

  /** Internal — wire a sync-throw reporter for the top-level validators. */
  bindValidatorErrorReporter(reporter: ((err: unknown) => void) | null): void {
    this.onValidatorError = reporter
  }

  constructor(
    schema: S,
    options?: FormOptions<S>,
    internalOptions?: { onValidatorError?: (err: unknown) => void },
  ) {
    // The brand is set here rather than as a computed class-field key: a
    // bundler keeps a class with a computed field key even when nothing uses
    // it, which kept all of forms in every bundle built from `dist`.
    brand(this, FORM_BRAND)
    this.fields = schema
    this.options = options
    this.validators = options?.validators ?? []
    this.asyncValidators = asyncValidatorFlags(this.validators)
    // Capture reporter BEFORE the top-level validator effect kicks off in
    // this constructor — mirrors the FieldImpl fix.
    this.onValidatorError = internalOptions?.onValidatorError ?? null

    // Initial values — supports both the static shape and the tracked-function
    // shape from spec §8.4. For the function form, wrap in an effect so a
    // change to any tracked signal re-seats the form (subject to the dirty
    // guard from `resetOnInitialChange`).
    // `null` is no initial, like `undefined`: a form cannot hold `null`, and a
    // field-array factory passes an item's `null` straight through (§8.3).
    if (options?.initial != null) {
      if (typeof options.initial === 'function') {
        const initialFn = options.initial
        const mode = options.resetOnInitialChange ?? 'when-clean'
        this.initialDispose = effect(() => {
          // Track signals read by `initialFn`. A throw routes like a validator
          // throw, to the controller's `onError`. Uncaught, it escaped into
          // whatever wrote the signal: a refetch that changed the data's shape
          // rejected with the form's TypeError. The reads made before the
          // throw stay tracked, so a later good value still re-seats.
          let ini: DeepPartial<FormValue<S>> | undefined
          try {
            ini = initialFn()
          } catch (err) {
            this.reportError(err)
            return
          }
          // `null` means no record yet, as `undefined` does.
          if (ini == null) return
          // The dirty guard MUST run untracked — otherwise `isDirty` would
          // become a dep and re-seating on user input would cascade.
          untracked(() => {
            if (this.disposed) return
            const partial = ini as DeepPartial<FormValue<S>>
            // Seating runs item factories and writes every field. A throw
            // there reaches `onError` too, not the write that re-ran the thunk
            // (§8.4). A field array builds its new items before it drops the
            // old ones, so a throw leaves it whole.
            try {
              if (!this.initialSeated) {
                // The first defined value fills what the user has not edited.
                // An edit made while the data loaded keeps its value, and only
                // its baseline moves (spec §8.4). A form-wide guard here left
                // every other field at its empty seed, for a save to write back.
                this.initialSeated = true
                if (mode === 'always') this.applyPartial(partial, true)
                else this.seatKeepingEdits(partial)
                return
              }
              if (mode === 'never') return
              // `computeBool` rather than `isDirty`, which the constructor
              // builds only after this effect's first run.
              if (mode !== 'always' && this.computeBool('isDirty')) return
              this.applyPartial(partial, true)
            } catch (err) {
              this.reportError(err)
            }
          })
        })
      } else {
        this.applyPartial(options.initial as DeepPartial<FormValue<S>>, true)
        this.staticInitial = copyPlainData(options.initial as DeepPartial<FormValue<S>>)
      }
    }

    this.value$ = computed(() => this.computeValue())
    this.errors = computed(() => this.computeErrors())
    this.isDirty = computed(() => this.computeBool('isDirty'))
    this.touched = computed(() => this.computeBool('touched'))
    this.isValidating = computed(() => {
      if (this.topLevelValidating$.value) return true
      for (const child of Object.values(this.fields)) {
        if ((child as { isValidating: ReadSignal<boolean> }).isValidating.value) return true
      }
      return false
    })
    // Merged view: this form's own top-level validators, any errors an
    // ancestor form-level validator routed onto this node (T5.2), and every
    // child. While anything in the subtree validates, the last settled answer
    // holds, as a field's does (spec §8.2), so a bound submit button doesn't
    // flicker.
    const liveValid = computed(() => {
      if (this.topLevelErrors.value.length > 0) return false
      for (const child of Object.values(this.fields)) {
        if (!(child as { isValid: ReadSignal<boolean> }).isValid.value) return false
      }
      return true
    })
    this.isValid = holdWhileValidating(this.isValidating, liveValid, (stop) => {
      this.validityDispose = stop
    })
    this.flatErrors = computed(() => this.computeFlatErrors())
    this.dirtyFields = computed(() => {
      const out: string[] = []
      collectDirtyFields(this.fields, '', out)
      return out
    })

    if (this.validators.length > 0) {
      this.validatorDispose = effect(() => this.runTopLevelValidators())
    }
  }

  get value(): FormValue<S> {
    return this.value$.value
  }

  peek(): FormValue<S> {
    return this.value$.peek()
  }

  subscribe(handler: (value: FormValue<S>) => void): () => void {
    return this.value$.subscribe(handler)
  }

  subscribeChanges(handler: (value: FormValue<S>) => void): () => void {
    return this.value$.subscribeChanges(handler)
  }

  private computeValue(): FormValue<S> {
    const out: Record<string, unknown> = {}
    // Every child — Field, Form or FieldArray — is a ReadSignal of its value.
    for (const [k, child] of Object.entries(this.fields)) {
      out[k] = (child as ReadSignal<unknown>).value
    }
    return out as FormValue<S>
  }

  private computeErrors(): FormErrors<S> {
    const out: Record<string, unknown> = {}
    for (const [k, child] of Object.entries(this.fields)) {
      if (isForm(child)) {
        out[k] = child.errors.value
      } else if (isFieldArray(child)) {
        out[k] = child.errors.value
      } else {
        const errs = (child as Field<unknown>).errors.value
        out[k] = errs.length > 0 ? errs : undefined
      }
    }
    return out as FormErrors<S>
  }

  private computeBool(key: 'isDirty' | 'touched'): boolean {
    for (const child of Object.values(this.fields)) {
      const sig = (child as unknown as Record<string, ReadSignal<boolean>>)[key]
      if (sig?.value) return true
    }
    return false
  }

  private computeFlatErrors(): Array<{ path: string; errors: string[] }> {
    const out: Array<{ path: string; errors: string[] }> = []
    const tle = this.topLevelErrors.value
    if (tle.length > 0) out.push({ path: '', errors: tle })
    walkErrors(this.fields, '', out)
    return out
  }

  set(partial: DeepPartial<FormValue<S>>): void {
    if (this.disposed) return
    batch(() => this.applyPartial(partial, false))
  }

  private applyPartial(partial: DeepPartial<FormValue<S>>, asInitial: boolean): void {
    // A missing record leaves the form alone (§8.3).
    if (partial == null) return
    for (const [k, val] of Object.entries(partial)) {
      // Own keys only: `fields` is a plain object, so `__proto__`, `constructor`
      // or `toString` in a partial (parsed JSON can carry them) would otherwise
      // find `Object.prototype` members and call `set` on them.
      if (!Object.hasOwn(this.fields, k)) continue
      const child = (this.fields as Record<string, unknown>)[k]
      if (!child) continue
      // `partial.someNestedForm === undefined` means "leave this subtree
      // alone", not "reset it with undefined" — which would crash on
      // `Object.entries(undefined)`. A nested form or field array cannot hold
      // `null` either, and JSON spells "no nested record" that way, so it
      // leaves the subtree alone too. A field takes `null` as its value.
      if (val === undefined || (val === null && !isLeaf(child))) continue
      // Field, Form and FieldArray share `set` and `setAsInitial`, each
      // taking its own value shape.
      const node = child as { set(v: unknown): void; setAsInitial(v: unknown): void }
      if (asInitial) node.setAsInitial(val)
      else node.set(val)
    }
  }

  setAsInitial(partial: DeepPartial<FormValue<S>>): void {
    if (this.disposed) return
    batch(() => {
      // A new baseline makes the last server response moot, as on a field.
      this.serverErrors$.set(null)
      this.applyPartial(partial, true)
    })
  }

  /**
   * Internal — seat `partial` as the baseline without discarding edits: a
   * clean child takes it through `setAsInitial`, a dirty nested form recurses,
   * and a dirty field or field array keeps its value and moves only its
   * baseline (`rebaseInitial`). The first `initial()` value lands this way
   * (§8.4).
   */
  seatKeepingEdits(partial: DeepPartial<FormValue<S>>): void {
    if (this.disposed) return
    for (const [k, val] of Object.entries(partial)) {
      // Own keys and defined values only, as in `applyPartial`.
      if (!Object.hasOwn(this.fields, k) || val === undefined) continue
      const child = (this.fields as Record<string, unknown>)[k] as SeatTarget | undefined
      if (!child || (val === null && !isLeaf(child))) continue
      if (!child.isDirty.peek()) child.setAsInitial(val)
      else if (typeof child.seatKeepingEdits === 'function') child.seatKeepingEdits(val)
      else child.rebaseInitial?.(val)
    }
  }

  reset(): void {
    if (this.disposed) return
    batch(() => {
      for (const child of Object.values(this.fields)) {
        if (isForm(child) || isFieldArray(child)) {
          ;(child as { reset: () => void }).reset()
        } else {
          ;(child as Field<unknown>).reset()
        }
      }
      // `topLevelErrors$` and `parentFormErrors` stay: this form's validators
      // and an ancestor's own them. A reset that changes the value re-runs
      // both, and one that does not leaves their last result standing, so a
      // rule that still fails stays visible (the same as a field's routed
      // errors).
      // Submission lifecycle is conceptually part of "form state"; resetting
      // a form means the user is starting over. Without these clears, a UI
      // bound to `submitCount`/`submitError` would show stale state after
      // `reset()`. `isSubmitting` is deliberately NOT cleared — only the
      // owning submit() flow can flip it back.
      this.submitCount$.set(0)
      this.submitError$.set(undefined)
      // `setErrors` messages go, as a field's server errors do on reset.
      this.serverErrors$.set(null)
      // Re-apply initial (as initial, no dirty bump) INSIDE the batch — a
      // separate pass would fire a second notification and briefly expose the
      // "reset to construction seed, then re-seat to current initial" tearing
      // (visible with a reactive `initial: () => …` whose deps changed) (T5.3).
      const ini = this.readInitial()
      if (ini !== undefined) {
        this.initialSeated = true
        this.applyPartial(ini, true)
      }
    })
  }

  /**
   * `options.initial` as `reset()` reads it. A thunk runs untracked, so a
   * `reset()` inside an effect does not subscribe that effect to what the
   * thunk reads. A throw reaches `onError`, as the reactive seat's does, and
   * reads as no value: the fields keep the baselines they reset to.
   */
  private readInitial(): DeepPartial<FormValue<S>> | undefined {
    const initial = this.options?.initial
    // A fixed object: a fresh copy of the form's own, so the fields never hold
    // the baseline itself.
    if (typeof initial !== 'function') {
      return this.staticInitial === undefined ? undefined : copyPlainData(this.staticInitial)
    }
    try {
      return untracked(initial) ?? undefined
    } catch (err) {
      this.reportError(err)
      return undefined
    }
  }

  markAllTouched(): void {
    if (this.disposed) return
    for (const child of Object.values(this.fields)) {
      if (isForm(child)) child.markAllTouched()
      else if (isFieldArray(child)) child.markAllTouched()
      else (child as Field<unknown>).markTouched()
    }
  }

  async validate(): Promise<boolean> {
    if (this.disposed) return this.isValid.peek()
    const tasks: Promise<unknown>[] = []
    for (const child of Object.values(this.fields)) {
      if (isForm(child) || isFieldArray(child)) {
        tasks.push((child as { validate: () => Promise<boolean> }).validate())
      } else {
        tasks.push((child as Field<unknown>).revalidate())
      }
    }
    await Promise.all(tasks)
    // Kick a fresh top-level run so the surface matches "re-run every
    // validator" — without this, `validate()` would skip top-level if it
    // settled before the call and the value hasn't tracked-changed since.
    if (this.validators.length > 0) {
      this.runTopLevelValidators()
    }
    // Wait for top-level validators to finish.
    if (this.topLevelValidating$.peek()) {
      await new Promise<void>((resolve) => {
        const unsub = this.topLevelValidating$.subscribe((v) => {
          if (!v) {
            unsub()
            resolve()
          }
        })
      })
    }
    return this.isValid.peek()
  }

  /**
   * Run a submission against this form. Wraps `handler(value)` with:
   * - `isSubmitting` set true while the handler is in flight.
   * - `submitCount` incremented before the handler runs.
   * - `submitError` set to the throw, if any.
   * - Optional pre-submit `validate()` (default true). When invalid every
   *   field is marked touched and the handler is skipped — the returned
   *   promise resolves with `{ ok: false, reason: 'invalid' }` and
   *   `submitError` is left untouched (validation failure is not a thrown
   *   error).
   *
   * The handler may return a value (synchronously or via Promise); it's
   * captured in the resolved object's `data` field. Throws resolve
   * `{ ok: false, reason: 'error', error }` unless `onError: 'rethrow'`. A
   * `resetOnSuccess: true` option calls `reset()` after the handler resolves
   * successfully.
   */
  async submit<R = unknown>(
    handler: (value: FormValue<S>) => R | Promise<R>,
    options?: SubmitOptions,
  ): Promise<SubmitResult<Awaited<R>>> {
    if (this.disposed) return { ok: false, reason: 'disposed' }

    // Double-submit guard — refusing to start a second submission while one
    // is in flight matches RHF / TanStack-Form. Consumers wanting parallel
    // submits should run them off the form directly.
    if (this.isSubmitting$.peek()) return { ok: false, reason: 'busy' }

    const validateFirst = options?.validateBeforeSubmit ?? true
    const onErrorMode = options?.onError ?? 'capture'

    batch(() => {
      this.submitCount$.update((n) => n + 1)
      this.submitError$.set(undefined)
      this.isSubmitting$.set(true)
    })

    try {
      if (validateFirst) {
        const ok = await this.validate()
        // Disposed while validating: the form is gone, so the handler must not
        // run on it. `dispose()` settled the validation, which is why this
        // point is reached at all.
        if (this.disposed) {
          this.isSubmitting$.set(false)
          return { ok: false, reason: 'disposed' }
        }
        if (!ok) {
          this.markAllTouched()
          this.isSubmitting$.set(false)
          return { ok: false, reason: 'invalid' }
        }
      }
      const result = (await handler(this.value$.peek())) as Awaited<R>
      if (options?.resetOnSuccess) this.reset()
      this.isSubmitting$.set(false)
      return { ok: true, data: result }
    } catch (err) {
      batch(() => {
        this.submitError$.set(err)
        this.isSubmitting$.set(false)
      })
      if (onErrorMode === 'rethrow') throw err
      return { ok: false, reason: 'error', error: err }
    }
  }

  /**
   * Pin externally-sourced errors on specific fields — typically server-side
   * validation results from a failed submit. Paths are dot-separated and
   * traverse nested `Form` / `FieldArray` children (numeric segments are
   * array indices). Errors land in the field's `serverErrors` channel and
   * clear automatically on the next user write to that field. Passing an
   * empty array for a path clears that field's server errors immediately.
   * A path naming a nested form or field array, or `''` for this form, pins
   * the messages on that node's `topLevelErrors` (see `PinnedErrors`).
   */
  setErrors(errors: Record<string, ReadonlyArray<string>>): void {
    if (this.disposed) return
    batch(() => {
      for (const [path, msgs] of Object.entries(errors)) {
        // `''` names this form, as it does in `flatErrors`.
        const target = path === '' ? this : this.resolvePath(path)
        if (target === undefined || target === null) continue
        // A nested form or field array takes the messages on its own
        // `topLevelErrors`. Its `setErrors`, where it has one, takes a record
        // of paths, and a list read as one split into stray paths.
        if (isForm(target) || isFieldArray(target)) {
          ;(target as { setServerErrors?: (e: ReadonlyArray<string>) => void }).setServerErrors?.(
            msgs,
          )
          continue
        }
        if ((target as { setErrors?: unknown }).setErrors === undefined) continue
        ;(target as { setErrors: (e: ReadonlyArray<string>) => void }).setErrors(msgs)
      }
    })
  }

  /**
   * Internal — pin `setErrors` messages on this form's own `topLevelErrors`
   * until its value next changes. An empty list clears them.
   */
  setServerErrors(errors: ReadonlyArray<string>): void {
    if (this.disposed) return
    this.serverErrors$.set(
      errors.length === 0 ? null : { errors: [...errors], against: this.value$.peek() },
    )
  }

  /**
   * Internal — receive errors routed here by the ancestor form-level validator
   * of `source` (a `FormIssue` whose path resolved to this nested form). See
   * `routeFormIssues`.
   */
  setFormErrors(errors: ReadonlyArray<string>, source: object): void {
    if (this.disposed) return
    this.parentFormErrors.set(source, errors)
  }

  /**
   * Reset a named subtree to its initial. `path` uses the same dotted /
   * bracket notation as `setErrors` / `flatErrors`. Useful when
   * `Form.set({foo: undefined})` would be ambiguous ("clear" vs "leave
   * alone" — the latter is what `set` does today).
   *
   * Walks via `resolvePath`; the resolved target must expose `reset()`
   * (Field, Form, or FieldArray all do). Unknown paths are silently
   * ignored — `flatErrors`-shaped paths from upstream code shouldn't
   * crash this. Pass an empty string to reset the whole form (same as
   * `form.reset()`).
   */
  clearSubtree(path: string): void {
    if (this.disposed) return
    if (path === '') {
      this.reset()
      return
    }
    const target = this.resolvePath(path) as { reset?: () => void } | undefined
    if (target === undefined) return
    if (typeof target.reset === 'function') target.reset()
  }

  private resolvePath(path: string): unknown {
    if (path === '') return undefined
    const segments = splitPath(path)
    if (segments === null) return undefined
    let cursor: unknown = this
    for (const seg of segments) {
      if (cursor === undefined || cursor === null) return undefined
      if (isForm(cursor)) {
        cursor = (cursor.fields as Record<string, unknown>)[seg]
        continue
      }
      if (isFieldArray(cursor)) {
        const idx = Number(seg)
        if (!Number.isInteger(idx) || idx < 0) return undefined
        cursor = (cursor as { at(i: number): unknown }).at(idx)
        continue
      }
      // Top-level dispatch — `this` is the FormImpl; walk via `fields`.
      if (cursor === this) {
        cursor = (this.fields as Record<string, unknown>)[seg]
        continue
      }
      return undefined
    }
    return cursor
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.validatorDispose?.()
    this.validityDispose?.()
    this.initialDispose?.()
    this.currentValidatorAbort?.abort()
    // The form-level pass in flight never settles now; end it so a
    // `validate()` or `submit()` waiting on it resolves (see FieldImpl).
    this.topLevelValidating$.set(false)
    for (const child of Object.values(this.fields)) {
      ;(child as { dispose?: () => void }).dispose?.()
    }
    const hooks = this.disposeHooks
    this.disposeHooks = null
    runDisposeHooks(hooks)
  }

  /** Internal — see `addNodeDisposeHook` in `./field.ts`. */
  addDisposeHook(fn: () => void): void {
    if (this.disposed) {
      fn()
      return
    }
    if (this.disposeHooks === null) this.disposeHooks = []
    this.disposeHooks.push(fn)
  }

  /**
   * Route a throw from `initial()` to the controller's error handler, the
   * reporter validator throws use.
   */
  private reportError(err: unknown): void {
    try {
      this.onValidatorError?.(err)
    } catch {
      // The reporter must not propagate.
    }
  }

  private runTopLevelValidators(): void {
    if (this.disposed) return
    const value = this.value$.value
    this.currentValidatorAbort?.abort()
    const abort = new AbortController()
    this.currentValidatorAbort = abort
    const myId = ++this.currentValidatorRun

    const {
      issues: syncIssues,
      failed,
      pending: asyncPromises,
    } = runLevelValidators(this.validators, this.asyncValidators, value, abort.signal, (err) =>
      this.reportError(err),
    )

    if (failed) {
      abandonAsyncResults(asyncPromises, abort)
      batch(() => {
        this.lastFormErrorTargets = routeFormIssues(
          this,
          syncIssues,
          this.topLevelErrors$,
          this.lastFormErrorTargets,
        )
        this.topLevelValidating$.set(false)
      })
      return
    }

    if (asyncPromises.length === 0) {
      batch(() => {
        this.lastFormErrorTargets = routeFormIssues(
          this,
          [],
          this.topLevelErrors$,
          this.lastFormErrorTargets,
        )
        this.topLevelValidating$.set(false)
      })
      return
    }

    batch(() => {
      this.lastFormErrorTargets = routeFormIssues(
        this,
        [],
        this.topLevelErrors$,
        this.lastFormErrorTargets,
      )
      this.topLevelValidating$.set(true)
    })

    Promise.allSettled(asyncPromises).then((results) => {
      if (myId !== this.currentValidatorRun || this.disposed) return
      const issues: FormIssue[] = []
      for (const r of results) {
        if (r.status === 'fulfilled') appendIssues(issues, r.value)
        else {
          // A rejected check is an error on this node, as it is on a field.
          const message = rejectionMessage(r.reason, (err) => this.reportError(err))
          if (message !== null) issues.push({ path: [], message })
        }
      }
      batch(() => {
        this.lastFormErrorTargets = routeFormIssues(
          this,
          issues,
          this.topLevelErrors$,
          this.lastFormErrorTargets,
        )
        this.topLevelValidating$.set(false)
      })
    })
  }
}

/**
 * Split a path string into segments, accepting both dot syntax (`users.0.name`)
 * and the bracket syntax `walkErrors` emits for array items (`users[0].name`).
 * Returns `null` if the path is malformed (unclosed bracket, empty bracket,
 * non-numeric bracket index).
 */
function splitPath(path: string): string[] | null {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]
    if (ch === '.') {
      if (current !== '') {
        out.push(current)
        current = ''
      }
      continue
    }
    if (ch === '[') {
      if (current !== '') {
        out.push(current)
        current = ''
      }
      const close = path.indexOf(']', i + 1)
      if (close === -1) return null
      const idx = path.slice(i + 1, close)
      if (idx === '' || !/^\d+$/.test(idx)) return null
      out.push(idx)
      i = close
      continue
    }
    if (ch === ']') return null
    current += ch
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * The dirty paths under `fields`, depth first. A field array that `add`,
 * `insert`, `remove`, `move` or `clear` changed lists its own path and none
 * below it: its indices no longer line up with the baseline, so a PATCH has
 * to send the whole array. `isDirty` counts that change the same way.
 */
function collectDirtyFields(fields: FormSchema, prefix: string, out: string[]): void {
  for (const [k, child] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (isForm(child)) {
      collectDirtyFields(child.fields, path, out)
    } else if (isFieldArray(child)) {
      if ((child as { structurallyDirty?: boolean }).structurallyDirty === true) {
        out.push(path)
        continue
      }
      const items = child.items.value
      items.forEach((item, idx) => {
        const itemPath = `${path}[${idx}]`
        if (isForm(item)) {
          collectDirtyFields(item.fields, itemPath, out)
        } else if ((item as Field<unknown>).isDirty.value) {
          out.push(itemPath)
        }
      })
    } else if ((child as Field<unknown>).isDirty.value) {
      out.push(path)
    }
  }
}

function walkErrors(
  fields: FormSchema,
  prefix: string,
  out: Array<{ path: string; errors: string[] }>,
): void {
  for (const [k, child] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (isForm(child)) {
      const tle = child.topLevelErrors.value
      if (tle.length > 0) out.push({ path, errors: tle })
      walkErrors(child.fields, path, out)
    } else if (isFieldArray(child)) {
      const tle = child.topLevelErrors.value
      if (tle.length > 0) out.push({ path, errors: tle })
      const items = child.items.value
      items.forEach((item, idx) => {
        const itemPath = `${path}[${idx}]`
        if (isForm(item)) {
          const itle = item.topLevelErrors.value
          if (itle.length > 0) out.push({ path: itemPath, errors: itle })
          walkErrors(item.fields, itemPath, out)
        } else {
          const errs = (item as Field<unknown>).errors.value
          if (errs.length > 0) out.push({ path: itemPath, errors: errs })
        }
      })
    } else {
      const errs = (child as Field<unknown>).errors.value
      if (errs.length > 0) out.push({ path, errors: errs })
    }
  }
}

class FieldArrayImpl<I extends Field<any> | Form<any>> implements FieldArray<I> {
  readonly items: ReadSignal<ReadonlyArray<I>>
  private readonly value$: ReadSignal<FieldArrayValue<I>>
  readonly errors: ReadSignal<Array<FieldArrayItemErrors<I> | undefined>>
  readonly size: ReadSignal<number>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>

  private readonly items$: Signal<I[]>
  /**
   * Structural dirtiness — flipped by `add`/`insert`/`remove`/`move`/`clear`.
   * Item-level `isDirty` alone misses these, so a reactive `initial` + the
   * default `resetOnInitialChange: 'when-clean'` would re-seat the array on a
   * background refetch and delete rows the user just added (T5.1). Cleared by
   * `reset()` and by an initial-driven re-seat (`setAsInitial`).
   */
  private readonly structurallyDirty$: Signal<boolean> = signal(false)
  private readonly topLevelErrors$: Signal<string[]> = signal([])
  /** Errors routed to this array by ancestor form-level validators (T5.2), one
   *  list per ancestor — merged into `topLevelErrors` beside the array's own
   *  validator output. */
  private readonly parentFormErrors = new RoutedErrors()
  /** `setErrors` messages on this array itself — see `PinnedErrors`. */
  private readonly serverErrors$: Signal<PinnedErrors | null> = signal(null)
  readonly topLevelErrors: ReadSignal<string[]> = computed(() =>
    mergeErrors(
      this.topLevelErrors$.value,
      pinnedFor(this.serverErrors$.value, () => this.value$.value),
      this.parentFormErrors.merged.value,
    ),
  )
  private readonly topLevelValidating$: Signal<boolean> = signal(false)
  /** Targets written by the last array-level run — cleared next run if absent. */
  private lastFormErrorTargets: Set<FormErrorTarget> = new Set()

  private readonly itemFactory: (initial?: ItemInitial<I>) => I
  /**
   * The rows `reset()` rebuilds from: the array's own `copyPlainData` copy, so
   * an item edited in place, as a Svelte nested bind edits it, cannot reach
   * it. `reset()` hands the factory a fresh copy of it.
   */
  private initialItems: Array<ItemInitial<I>> = []
  private readonly validators: ReadonlyArray<FieldArrayValidator<I>>
  /** Which array-level validators count as async — see `asyncValidatorFlags`. */
  private readonly asyncValidators: boolean[]
  private currentValidatorRun = 0
  private currentValidatorAbort: AbortController | null = null
  private validatorDispose: (() => void) | null = null
  private validityDispose: (() => void) | null = null
  private disposed = false
  private disposeHooks: Array<() => void> | null = null
  private onValidatorError: ((err: unknown) => void) | null = null

  /** Internal — see `FormImpl.bindValidatorErrorReporter`. */
  bindValidatorErrorReporter(reporter: ((err: unknown) => void) | null): void {
    this.onValidatorError = reporter
  }

  constructor(
    itemFactory: (initial?: ItemInitial<I>) => I,
    options?: FieldArrayOptions<I>,
    internalOptions?: { onValidatorError?: (err: unknown) => void },
  ) {
    brand(this, FIELD_ARRAY_BRAND) // see FormImpl's constructor
    this.itemFactory = itemFactory
    this.validators = options?.validators ?? []
    this.asyncValidators = asyncValidatorFlags(this.validators)
    this.onValidatorError = internalOptions?.onValidatorError ?? null
    this.items$ = signal<I[]>([])
    if (options?.initial) {
      this.initialItems = copyPlainData(options.initial)
      for (const ini of options.initial) {
        this.items$.peek().push(itemFactory(ini))
      }
      // re-set to trigger subscribers
      this.items$.set([...this.items$.peek()])
    }

    // A read-only view: writing the backing list would skip item disposal.
    this.items = readOnly(this.items$)
    this.size = computed(() => this.items$.value.length)
    // Every item — Field or Form — is a ReadSignal of its value.
    this.value$ = computed(
      () =>
        this.items$.value.map((item) => (item as ReadSignal<unknown>).value) as FieldArrayValue<I>,
    )
    this.errors = computed(() =>
      this.items$.value.map((item) => {
        if (isForm(item)) return item.errors.value as FieldArrayItemErrors<I>
        const errs = (item as Field<unknown>).errors.value
        return (errs.length > 0 ? errs : undefined) as FieldArrayItemErrors<I> | undefined
      }),
    )
    this.isDirty = computed(() => {
      if (this.structurallyDirty$.value) return true // add/remove/move/clear
      for (const item of this.items$.value) {
        if ((item as { isDirty: ReadSignal<boolean> }).isDirty.value) return true
      }
      return false
    })
    this.touched = computed(() => {
      for (const item of this.items$.value) {
        if ((item as { touched: ReadSignal<boolean> }).touched.value) return true
      }
      return false
    })
    this.isValidating = computed(() => {
      if (this.topLevelValidating$.value) return true
      for (const item of this.items$.value) {
        if ((item as { isValidating: ReadSignal<boolean> }).isValidating.value) return true
      }
      return false
    })
    // Same merged view and the same hold as `FormImpl.isValid`.
    const liveValid = computed(() => {
      if (this.topLevelErrors.value.length > 0) return false
      for (const item of this.items$.value) {
        if (!(item as { isValid: ReadSignal<boolean> }).isValid.value) return false
      }
      return true
    })
    this.isValid = holdWhileValidating(this.isValidating, liveValid, (stop) => {
      this.validityDispose = stop
    })

    if (this.validators.length > 0) {
      this.validatorDispose = effect(() => this.runTopLevelValidators())
    }
  }

  get value(): FieldArrayValue<I> {
    return this.value$.value
  }

  peek(): FieldArrayValue<I> {
    return this.value$.peek()
  }

  subscribe(handler: (value: FieldArrayValue<I>) => void): () => void {
    return this.value$.subscribe(handler)
  }

  subscribeChanges(handler: (value: FieldArrayValue<I>) => void): () => void {
    return this.value$.subscribeChanges(handler)
  }

  at(index: number): I | undefined {
    return this.items$.peek()[index]
  }

  /**
   * Internal — `true` after `add`, `insert`, `remove`, `move` or `clear`,
   * until `reset()` or `setAsInitial()`. A tracked read. `dirtyFields` lists
   * such an array by its own path.
   */
  get structurallyDirty(): boolean {
    return this.structurallyDirty$.value
  }

  /**
   * Internal — pin `setErrors` messages on this array's own `topLevelErrors`
   * until its value next changes, a row added or removed included.
   */
  setServerErrors(errors: ReadonlyArray<string>): void {
    if (this.disposed) return
    this.serverErrors$.set(
      errors.length === 0 ? null : { errors: [...errors], against: this.value$.peek() },
    )
  }

  /**
   * Internal — receive errors routed here by the ancestor form-level validator
   * of `source` (a `FormIssue` whose path resolved to this array). See
   * `routeFormIssues`.
   */
  setFormErrors(errors: ReadonlyArray<string>, source: object): void {
    if (this.disposed) return
    this.parentFormErrors.set(source, errors)
  }

  add(initial?: ItemInitial<I>): void {
    if (this.disposed) return
    const item = this.itemFactory(initial)
    this.items$.set([...this.items$.peek(), item])
    this.structurallyDirty$.set(true)
  }

  insert(index: number, initial?: ItemInitial<I>): void {
    if (this.disposed) return
    const item = this.itemFactory(initial)
    const next = [...this.items$.peek()]
    next.splice(index, 0, item)
    this.items$.set(next)
    this.structurallyDirty$.set(true)
  }

  remove(index: number): void {
    if (this.disposed) return
    // Out of range changes nothing, so it must not mark the array dirty.
    if (index < 0 || index >= this.items$.peek().length) return
    const next = [...this.items$.peek()]
    const [removed] = next.splice(index, 1)
    if (removed) {
      ;(removed as { dispose?: () => void }).dispose?.()
    }
    this.items$.set(next)
    this.structurallyDirty$.set(true)
  }

  move(from: number, to: number): void {
    if (this.disposed) return
    if (from < 0 || from >= this.items$.peek().length || from === to) return
    const next = [...this.items$.peek()]
    const [item] = next.splice(from, 1)
    if (item) next.splice(to, 0, item)
    this.items$.set(next)
    this.structurallyDirty$.set(true)
  }

  clear(): void {
    if (this.disposed) return
    for (const item of this.items$.peek()) {
      ;(item as { dispose?: () => void }).dispose?.()
    }
    this.items$.set([])
    this.structurallyDirty$.set(true)
  }

  set(values: ReadonlyArray<ItemInitial<I>>): void {
    if (this.disposed) return
    batch(() => {
      // Preserve item identity where the lengths overlap, so touched / dirty /
      // in-flight validators on existing items survive. The tail diff handles
      // grow and shrink.
      const current = this.items$.peek()
      const overlap = Math.min(current.length, values.length)
      for (let i = 0; i < overlap; i++) {
        ;(current[i] as { set(v: unknown): void }).set(values[i])
      }
      for (let i = current.length; i < values.length; i++) this.add(values[i])
      for (let i = current.length - 1; i >= values.length; i--) this.remove(i)
    })
  }

  setAsInitial(values: ReadonlyArray<ItemInitial<I>>): void {
    if (this.disposed) return
    // Rebuild the items wholesale and re-anchor them as the initial, so a
    // later `reset()` returns here rather than to the construction initials.
    this.replaceItems(values)
    this.initialItems = copyPlainData([...values])
  }

  /**
   * Swap every item for one built from `values`, on the clean baseline: not
   * structurally dirty (T5.1), and with no `setErrors` messages. The new items
   * are built before the old ones go. A factory that throws disposes the
   * items built so far and leaves the array as it was, and the throw
   * propagates.
   */
  private replaceItems(values: ReadonlyArray<ItemInitial<I>>): void {
    const next: I[] = []
    try {
      for (const v of values) next.push(this.itemFactory(v))
    } catch (err) {
      for (const item of next) (item as { dispose?: () => void }).dispose?.()
      throw err
    }
    batch(() => {
      for (const item of this.items$.peek()) (item as { dispose?: () => void }).dispose?.()
      this.items$.set(next)
      this.structurallyDirty$.set(false)
      this.serverErrors$.set(null)
    })
  }

  /**
   * Internal — move `reset()`'s target to `values` and keep the current
   * items. `Form` calls it for the first `initial()` value on an array the
   * user already changed (§8.4). The items were not built from the new
   * baseline, so the array stays dirty until `reset()` or `setAsInitial`.
   */
  rebaseInitial(values: ReadonlyArray<ItemInitial<I>>): void {
    if (this.disposed) return
    this.initialItems = copyPlainData([...values])
    this.structurallyDirty$.set(true)
  }

  reset(): void {
    if (this.disposed) return
    // The validator error channels stay with their validators, as in
    // `FormImpl.reset`. Rebuilt items give the array a new value, so both
    // re-run anyway.
    this.replaceItems(copyPlainData(this.initialItems))
  }

  markAllTouched(): void {
    for (const item of this.items$.peek()) {
      if (isForm(item)) item.markAllTouched()
      else (item as Field<unknown>).markTouched()
    }
  }

  async validate(): Promise<boolean> {
    if (this.disposed) return this.isValid.peek()
    const tasks: Promise<unknown>[] = []
    for (const item of this.items$.peek()) {
      if (isForm(item)) tasks.push(item.validate())
      else tasks.push((item as Field<unknown>).revalidate())
    }
    await Promise.all(tasks)
    // Fresh top-level run — see `FormImpl.validate` for the rationale.
    if (this.validators.length > 0) {
      this.runTopLevelValidators()
    }
    if (this.topLevelValidating$.peek()) {
      await new Promise<void>((resolve) => {
        const unsub = this.topLevelValidating$.subscribe((v) => {
          if (!v) {
            unsub()
            resolve()
          }
        })
      })
    }
    return this.isValid.peek()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.validatorDispose?.()
    this.validityDispose?.()
    this.currentValidatorAbort?.abort()
    // End the array-level pass in flight, as `FormImpl.dispose` does.
    this.topLevelValidating$.set(false)
    for (const item of this.items$.peek()) {
      ;(item as { dispose?: () => void }).dispose?.()
    }
    const hooks = this.disposeHooks
    this.disposeHooks = null
    runDisposeHooks(hooks)
  }

  /** Internal — see `addNodeDisposeHook` in `./field.ts`. */
  addDisposeHook(fn: () => void): void {
    if (this.disposed) {
      fn()
      return
    }
    if (this.disposeHooks === null) this.disposeHooks = []
    this.disposeHooks.push(fn)
  }

  private runTopLevelValidators(): void {
    if (this.disposed) return
    const value = this.value$.value
    this.currentValidatorAbort?.abort()
    const abort = new AbortController()
    this.currentValidatorAbort = abort
    const myId = ++this.currentValidatorRun

    const {
      issues: syncIssues,
      failed,
      pending: asyncPromises,
    } = runLevelValidators(this.validators, this.asyncValidators, value, abort.signal, (err) => {
      try {
        this.onValidatorError?.(err)
      } catch {
        // The reporter must not propagate.
      }
    })

    if (failed) {
      abandonAsyncResults(asyncPromises, abort)
      batch(() => {
        this.lastFormErrorTargets = routeFormIssues(
          this,
          syncIssues,
          this.topLevelErrors$,
          this.lastFormErrorTargets,
        )
        this.topLevelValidating$.set(false)
      })
      return
    }

    if (asyncPromises.length === 0) {
      batch(() => {
        this.lastFormErrorTargets = routeFormIssues(
          this,
          [],
          this.topLevelErrors$,
          this.lastFormErrorTargets,
        )
        this.topLevelValidating$.set(false)
      })
      return
    }

    batch(() => {
      this.lastFormErrorTargets = routeFormIssues(
        this,
        [],
        this.topLevelErrors$,
        this.lastFormErrorTargets,
      )
      this.topLevelValidating$.set(true)
    })

    Promise.allSettled(asyncPromises).then((results) => {
      if (myId !== this.currentValidatorRun || this.disposed) return
      const issues: FormIssue[] = []
      for (const r of results) {
        if (r.status === 'fulfilled') appendIssues(issues, r.value)
        else {
          // A rejected check is an error on this node, as it is on a field.
          const message = rejectionMessage(r.reason, (err) => this.onValidatorError?.(err))
          if (message !== null) issues.push({ path: [], message })
        }
      }
      batch(() => {
        this.lastFormErrorTargets = routeFormIssues(
          this,
          issues,
          this.topLevelErrors$,
          this.lastFormErrorTargets,
        )
        this.topLevelValidating$.set(false)
      })
    })
  }
}

export function createForm<S extends FormSchema>(
  schema: S,
  options?: FormOptions<S>,
  internalOptions?: { onValidatorError?: (err: unknown) => void },
): Form<S> {
  return new FormImpl(schema, options, internalOptions)
}

export function createFieldArray<I extends Field<any> | Form<any>>(
  itemFactory: (initial?: ItemInitial<I>) => I,
  options?: FieldArrayOptions<I>,
  internalOptions?: { onValidatorError?: (err: unknown) => void },
): FieldArray<I> {
  return new FieldArrayImpl<I>(itemFactory, options, internalOptions)
}

/**
 * Recursively wire every leaf `Field` in a form / field-array tree to a
 * devtools emitter. Returns a single disposer that tears down every standalone
 * `effect()` registered along the way (used for FieldArray watching), so the
 * caller — `createForm` / `createFieldArray` in the controller — can register one
 * cleanup entry and have the whole subtree's reactive work die with the
 * controller. Spec §20.9.
 */
export function bindTreeToDevtools(
  node: Field<unknown> | Form<FormSchema> | FieldArray<Field<unknown> | Form<FormSchema>>,
  prefix: string,
  controllerPath: readonly string[],
  emitter: import('../devtools').DevtoolsEmitter,
): () => void {
  const disposers: Array<() => void> = []
  bindTreeToDevtoolsInto(node, prefix, controllerPath, emitter, disposers)
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // Disposer failures must not break sibling cleanup.
      }
    }
    disposers.length = 0
  }
}

function bindTreeToDevtoolsInto(
  node: Field<unknown> | Form<FormSchema> | FieldArray<Field<unknown> | Form<FormSchema>>,
  prefix: string,
  controllerPath: readonly string[],
  emitter: import('../devtools').DevtoolsEmitter,
  disposers: Array<() => void>,
): void {
  if (isForm(node)) {
    for (const [key, child] of Object.entries(node.fields)) {
      bindTreeToDevtoolsInto(
        child,
        prefix === '' ? key : `${prefix}.${key}`,
        controllerPath,
        emitter,
        disposers,
      )
    }
    return
  }
  if (isFieldArray(node)) {
    // Re-bind on every items change so dynamically-added entries get tracked.
    // Each re-bind has its own disposer set scoped to that pass; on the next
    // items change we flush the previous pass's disposers BEFORE creating the
    // new effects, so a churning array doesn't accumulate reactive work.
    // (Pre-fix, every items mutation appended fresh effects to the outer
    // `disposers` array and never released the old ones.)
    const arr = node as FieldArray<Field<unknown> | Form<FormSchema>>
    let perPass: Array<() => void> = []
    const stop = effect(() => {
      const items = arr.items.value
      // Flush previous pass before rebinding the new item set.
      for (const d of perPass) {
        try {
          d()
        } catch {
          // Disposer failures must not break sibling cleanup.
        }
      }
      perPass = []
      items.forEach((item, idx) => {
        bindTreeToDevtoolsInto(item, `${prefix}[${idx}]`, controllerPath, emitter, perPass)
      })
    })
    disposers.push(stop)
    // On final dispose, drain the per-pass disposers too.
    disposers.push(() => {
      for (const d of perPass) {
        try {
          d()
        } catch {
          // Ignore.
        }
      }
      perPass = []
    })
    return
  }
  // Leaf Field.
  bindFieldDevtoolsOwner(node as Field<unknown>, {
    controllerPath,
    fieldName: prefix,
    emitter,
  })
}

/**
 * Walk a Form/FieldArray subtree and install `reporter` on every level —
 * leaf fields, nested forms' top-level validators, and field-arrays' top-level
 * validators. Called by `createForm` / `createFieldArray` so synchronous validator
 * throws anywhere in the tree route through `root.onError`. See
 * `ValidatorErrorReporter` in `./field.ts`.
 */
export function bindTreeValidatorErrorReporter(
  node: Field<unknown> | Form<FormSchema> | FieldArray<Field<unknown> | Form<FormSchema>>,
  reporter: ValidatorErrorReporter | null,
): void {
  if (isForm(node)) {
    const impl = node as { bindValidatorErrorReporter?: (r: ValidatorErrorReporter | null) => void }
    impl.bindValidatorErrorReporter?.(reporter)
    for (const child of Object.values(node.fields)) {
      bindTreeValidatorErrorReporter(child, reporter)
    }
    return
  }
  if (isFieldArray(node)) {
    const impl = node as { bindValidatorErrorReporter?: (r: ValidatorErrorReporter | null) => void }
    impl.bindValidatorErrorReporter?.(reporter)
    // Items currently in the array. (Items added later won't get the reporter
    // unless `createFieldArray` is wrapped to rebind — but the leaf items in the
    // typical pattern come from a user factory that constructs through
    // `createField` and is bound here by the parent traversal.)
    for (const item of node.items.value) {
      bindTreeValidatorErrorReporter(item, reporter)
    }
    return
  }
  bindFieldValidatorErrorReporter(node as Field<unknown>, reporter)
}
