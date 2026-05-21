import type { Field } from '../controller/types'
import { batch, computed, effect, type Signal, signal, untracked } from '../signals'
import type { ReadSignal } from '../signals/types'
import {
  bindFieldDevtoolsOwner,
  bindFieldValidatorErrorReporter,
  createField,
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
} from './form-types'

const FORM_BRAND = Symbol.for('olas.form')
const FIELD_ARRAY_BRAND = Symbol.for('olas.fieldArray')

const isForm = (x: unknown): x is Form<FormSchema> =>
  typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[FORM_BRAND] === true

const isFieldArray = (x: unknown): x is FieldArray<Field<unknown> | Form<FormSchema>> =>
  typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[FIELD_ARRAY_BRAND] === true

const isField = (x: unknown): x is Field<unknown> =>
  typeof x === 'object' && x !== null && !isForm(x) && !isFieldArray(x)

class FormImpl<S extends FormSchema> implements Form<S> {
  readonly [FORM_BRAND] = true

  readonly fields: S
  readonly value: ReadSignal<FormValue<S>>
  readonly errors: ReadSignal<FormErrors<S>>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly flatErrors: ReadSignal<Array<{ path: string; errors: string[] }>>

  private readonly topLevelErrors$: Signal<string[]> = signal([])
  readonly topLevelErrors: ReadSignal<string[]> = this.topLevelErrors$
  private readonly topLevelValidating$: Signal<boolean> = signal(false)

  // Submission lifecycle.
  private readonly isSubmitting$: Signal<boolean> = signal(false)
  private readonly submitCount$: Signal<number> = signal(0)
  private readonly submitError$: Signal<unknown> = signal(undefined)
  readonly isSubmitting: ReadSignal<boolean> = this.isSubmitting$
  readonly submitCount: ReadSignal<number> = this.submitCount$
  readonly submitError: ReadSignal<unknown> = this.submitError$

  private readonly validators: ReadonlyArray<FormValidator<S>>
  private readonly options: FormOptions<S> | undefined
  private validatorDispose: (() => void) | null = null
  private initialDispose: (() => void) | null = null
  private currentValidatorRun = 0
  private currentValidatorAbort: AbortController | null = null
  private disposed = false
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
    this.fields = schema
    this.options = options
    this.validators = options?.validators ?? []
    // Capture reporter BEFORE the top-level validator effect kicks off in
    // this constructor — mirrors the FieldImpl fix.
    this.onValidatorError = internalOptions?.onValidatorError ?? null

    // Initial values — supports both the static shape and the tracked-function
    // shape from spec §8.4. For the function form, wrap in an effect so a
    // change to any tracked signal re-seats the form (subject to the dirty
    // guard from `resetOnInitialChange`).
    if (options?.initial !== undefined) {
      if (typeof options.initial === 'function') {
        const initialFn = options.initial
        const mode = options.resetOnInitialChange ?? 'when-clean'
        let firstRun = true
        this.initialDispose = effect(() => {
          // Track signals read by `initialFn`. The dirty-guard MUST run
          // untracked — otherwise `isDirty` would become a dep and re-seating
          // on user input would cascade.
          const ini = initialFn()
          if (ini === undefined) return
          untracked(() => {
            if (this.disposed) return
            if (firstRun) {
              firstRun = false
              this.applyPartial(ini as DeepPartial<FormValue<S>>, true)
              return
            }
            if (mode === 'never') return
            if (mode === 'when-clean' && this.isDirty.peek()) return
            this.applyPartial(ini as DeepPartial<FormValue<S>>, true)
          })
        })
      } else {
        this.applyPartial(options.initial as DeepPartial<FormValue<S>>, true)
      }
    }

    this.value = computed(() => this.computeValue())
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
    this.isValid = computed(() => {
      if (this.topLevelErrors$.value.length > 0) return false
      if (this.isValidating.value) return false
      for (const child of Object.values(this.fields)) {
        if (!(child as { isValid: ReadSignal<boolean> }).isValid.value) return false
      }
      return true
    })
    this.flatErrors = computed(() => this.computeFlatErrors())

    if (this.validators.length > 0) {
      this.validatorDispose = effect(() => this.runTopLevelValidators())
    }
  }

  private computeValue(): FormValue<S> {
    const out: Record<string, unknown> = {}
    for (const [k, child] of Object.entries(this.fields)) {
      if (isForm(child) || isFieldArray(child)) {
        out[k] = (child as { value: ReadSignal<unknown> }).value.value
      } else {
        // Field<T> is itself a ReadSignal<T>; .value returns T (tracked).
        out[k] = (child as Field<unknown>).value
      }
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
    const tle = this.topLevelErrors$.value
    if (tle.length > 0) out.push({ path: '', errors: tle })
    walkErrors(this.fields, '', out)
    return out
  }

  set(partial: DeepPartial<FormValue<S>>): void {
    if (this.disposed) return
    batch(() => this.applyPartial(partial, false))
  }

  private applyPartial(partial: DeepPartial<FormValue<S>>, asInitial: boolean): void {
    for (const [k, val] of Object.entries(partial)) {
      const child = (this.fields as Record<string, unknown>)[k]
      if (!child) continue
      // `partial.someNestedForm === undefined` means "leave this subtree
      // alone", not "reset it with undefined" — which would crash on
      // `Object.entries(undefined)`.
      if (val === undefined) continue
      if (isForm(child)) {
        // Nested form: recurse via its own `set` (user) or rebuild via reset
        // through the same `applyPartial`-with-`asInitial` flag (initial).
        if (asInitial) {
          ;(child as Form<FormSchema>).resetWithInitial(val as DeepPartial<FormValue<FormSchema>>)
        } else {
          child.set(val as DeepPartial<FormValue<FormSchema>>)
        }
      } else if (isFieldArray(child)) {
        const arr = child
        const newValues = val as unknown[]
        if (asInitial) {
          // Reset-style application: replace items wholesale and re-anchor
          // them as the new initial so a later `reset()` returns here.
          arr.clear()
          for (const itemVal of newValues) {
            arr.add(itemVal as ItemInitial<Field<unknown>>)
          }
          // Internal: re-anchor the initialItems list. `replaceInitialItems`
          // is only exposed for this exact use case.
          ;(
            arr as unknown as {
              replaceInitialItems: (items: ReadonlyArray<unknown>) => void
            }
          ).replaceInitialItems(newValues)
        } else {
          // User-driven patch: preserve item identity where the lengths
          // overlap so touched / dirty / in-flight validators on existing
          // items survive. Tail diff handles grow / shrink.
          const current = arr.items.peek() as ReadonlyArray<Field<unknown> | Form<FormSchema>>
          const overlap = Math.min(current.length, newValues.length)
          for (let i = 0; i < overlap; i++) {
            const item = current[i]
            const v = newValues[i]
            if (isForm(item)) {
              item.set(v as DeepPartial<FormValue<FormSchema>>)
            } else {
              ;(item as Field<unknown>).set(v)
            }
          }
          for (let i = current.length; i < newValues.length; i++) {
            arr.add(newValues[i] as ItemInitial<Field<unknown>>)
          }
          for (let i = current.length - 1; i >= newValues.length; i--) {
            arr.remove(i)
          }
        }
      } else {
        const f = child as Field<unknown>
        if (asInitial) f.setAsInitial(val)
        else f.set(val)
      }
    }
  }

  /** Internal: re-seat this form's leaves from `partial` as their new initial. */
  resetWithInitial(partial: DeepPartial<FormValue<S>>): void {
    if (this.disposed) return
    batch(() => this.applyPartial(partial, true))
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
      this.topLevelErrors$.set([])
    })
    // Re-apply initial if provided — as initial (no dirty bump).
    if (this.options?.initial !== undefined) {
      const ini =
        typeof this.options.initial === 'function' ? this.options.initial() : this.options.initial
      if (ini !== undefined) this.applyPartial(ini as DeepPartial<FormValue<S>>, true)
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
   *   promise resolves with `{ ok: false }` and `submitError` is left
   *   untouched (validation failure is not a thrown error).
   *
   * The handler may return a value (synchronously or via Promise); it's
   * captured in the resolved object's `data` field. Throws are captured
   * unless `onError: 'rethrow'`. A `resetOnSuccess: true` option calls
   * `reset()` after the handler resolves successfully.
   */
  async submit(
    handler: (value: FormValue<S>) => unknown | Promise<unknown>,
    options?: {
      validateBeforeSubmit?: boolean
      resetOnSuccess?: boolean
      onError?: 'rethrow' | 'capture'
    },
  ): Promise<{ ok: boolean; data?: unknown; error?: unknown }> {
    if (this.disposed) return { ok: false, error: new Error('form is disposed') }

    // Double-submit guard — refusing to start a second submission while one
    // is in flight matches RHF / TanStack-Form. Consumers wanting parallel
    // submits should run them off the form directly.
    if (this.isSubmitting$.peek()) {
      return { ok: false, error: new Error('submit already in progress') }
    }

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
        if (!ok) {
          this.markAllTouched()
          this.isSubmitting$.set(false)
          return { ok: false }
        }
      }
      const result = await handler(this.value.peek())
      if (options?.resetOnSuccess) this.reset()
      this.isSubmitting$.set(false)
      return { ok: true, data: result }
    } catch (err) {
      batch(() => {
        this.submitError$.set(err)
        this.isSubmitting$.set(false)
      })
      if (onErrorMode === 'rethrow') throw err
      return { ok: false, error: err }
    }
  }

  /**
   * Pin externally-sourced errors on specific fields — typically server-side
   * validation results from a failed submit. Paths are dot-separated and
   * traverse nested `Form` / `FieldArray` children (numeric segments are
   * array indices). Errors land in the field's `serverErrors` channel and
   * clear automatically on the next user write to that field. Passing an
   * empty array for a path clears that field's server errors immediately.
   */
  setErrors(errors: Record<string, ReadonlyArray<string>>): void {
    if (this.disposed) return
    batch(() => {
      for (const [path, msgs] of Object.entries(errors)) {
        const target = this.resolvePath(path)
        if (target === undefined) continue
        if ((target as { setErrors?: unknown }).setErrors === undefined) continue
        ;(target as { setErrors: (e: ReadonlyArray<string>) => void }).setErrors(msgs)
      }
    })
  }

  private resolvePath(path: string): unknown {
    if (path === '') return undefined
    const segments = path.split('.')
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
    this.initialDispose?.()
    this.currentValidatorAbort?.abort()
    for (const child of Object.values(this.fields)) {
      ;(child as { dispose?: () => void }).dispose?.()
    }
  }

  private runTopLevelValidators(): void {
    if (this.disposed) return
    const value = this.value.value
    this.currentValidatorAbort?.abort()
    const abort = new AbortController()
    this.currentValidatorAbort = abort
    const myId = ++this.currentValidatorRun

    const syncErrors: string[] = []
    const asyncPromises: Promise<string | null>[] = []
    for (const v of this.validators) {
      try {
        const r = v(value, abort.signal)
        if (r instanceof Promise) asyncPromises.push(r)
        else if (r != null) syncErrors.push(r)
      } catch (err) {
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
        this.topLevelErrors$.set(syncErrors)
        this.topLevelValidating$.set(false)
      })
      return
    }

    if (asyncPromises.length === 0) {
      batch(() => {
        this.topLevelErrors$.set([])
        this.topLevelValidating$.set(false)
      })
      return
    }

    batch(() => {
      this.topLevelErrors$.set([])
      this.topLevelValidating$.set(true)
    })

    Promise.allSettled(asyncPromises).then((results) => {
      if (myId !== this.currentValidatorRun || this.disposed) return
      const errs: string[] = []
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value != null) errs.push(r.value)
      }
      batch(() => {
        this.topLevelErrors$.set(errs)
        this.topLevelValidating$.set(false)
      })
    })
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
  readonly [FIELD_ARRAY_BRAND] = true

  readonly items: ReadSignal<ReadonlyArray<I>>
  readonly value: ReadSignal<FieldArrayValue<I>>
  readonly errors: ReadSignal<Array<FieldArrayItemErrors<I> | undefined>>
  readonly size: ReadSignal<number>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>

  private readonly items$: Signal<I[]>
  private readonly topLevelErrors$: Signal<string[]> = signal([])
  readonly topLevelErrors: ReadSignal<string[]> = this.topLevelErrors$
  private readonly topLevelValidating$: Signal<boolean> = signal(false)

  private readonly itemFactory: (initial?: ItemInitial<I>) => I
  private initialItems: Array<ItemInitial<I>> = []
  private readonly validators: ReadonlyArray<FieldArrayValidator<I>>
  private currentValidatorRun = 0
  private currentValidatorAbort: AbortController | null = null
  private validatorDispose: (() => void) | null = null
  private disposed = false
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
    this.itemFactory = itemFactory
    this.validators = options?.validators ?? []
    this.onValidatorError = internalOptions?.onValidatorError ?? null
    this.items$ = signal<I[]>([])
    if (options?.initial) {
      this.initialItems = options.initial
      for (const ini of options.initial) {
        this.items$.peek().push(itemFactory(ini))
      }
      // re-set to trigger subscribers
      this.items$.set([...this.items$.peek()])
    }

    this.items = this.items$
    this.size = computed(() => this.items$.value.length)
    this.value = computed(
      () =>
        this.items$.value.map((item) => {
          if (isForm(item)) return item.value.value
          // Field is a ReadSignal — `.value` is the actual value.
          return (item as Field<unknown>).value
        }) as FieldArrayValue<I>,
    )
    this.errors = computed(() =>
      this.items$.value.map((item) => {
        if (isForm(item)) return item.errors.value as FieldArrayItemErrors<I>
        const errs = (item as Field<unknown>).errors.value
        return (errs.length > 0 ? errs : undefined) as FieldArrayItemErrors<I> | undefined
      }),
    )
    this.isDirty = computed(() => {
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
    this.isValid = computed(() => {
      if (this.topLevelErrors$.value.length > 0) return false
      if (this.isValidating.value) return false
      for (const item of this.items$.value) {
        if (!(item as { isValid: ReadSignal<boolean> }).isValid.value) return false
      }
      return true
    })

    if (this.validators.length > 0) {
      this.validatorDispose = effect(() => this.runTopLevelValidators())
    }
  }

  at(index: number): I | undefined {
    return this.items$.peek()[index]
  }

  add(initial?: ItemInitial<I>): void {
    if (this.disposed) return
    const item = this.itemFactory(initial)
    this.items$.set([...this.items$.peek(), item])
  }

  insert(index: number, initial?: ItemInitial<I>): void {
    if (this.disposed) return
    const item = this.itemFactory(initial)
    const next = [...this.items$.peek()]
    next.splice(index, 0, item)
    this.items$.set(next)
  }

  remove(index: number): void {
    if (this.disposed) return
    const next = [...this.items$.peek()]
    const [removed] = next.splice(index, 1)
    if (removed) {
      ;(removed as { dispose?: () => void }).dispose?.()
    }
    this.items$.set(next)
  }

  move(from: number, to: number): void {
    if (this.disposed) return
    const next = [...this.items$.peek()]
    const [item] = next.splice(from, 1)
    if (item) next.splice(to, 0, item)
    this.items$.set(next)
  }

  clear(): void {
    if (this.disposed) return
    for (const item of this.items$.peek()) {
      ;(item as { dispose?: () => void }).dispose?.()
    }
    this.items$.set([])
  }

  /**
   * Internal — used by `Form.resetWithInitial` to re-anchor the array's
   * initial items after a parent-driven `applyPartial(..., asInitial: true)`.
   * Without this, a subsequent `reset()` would revert to the construction-
   * time initials rather than the most-recently-applied ones.
   */
  replaceInitialItems(items: ReadonlyArray<ItemInitial<I>>): void {
    this.initialItems = [...items]
  }

  reset(): void {
    if (this.disposed) return
    batch(() => {
      this.clear()
      for (const ini of this.initialItems) {
        this.add(ini)
      }
      this.topLevelErrors$.set([])
    })
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
    this.currentValidatorAbort?.abort()
    for (const item of this.items$.peek()) {
      ;(item as { dispose?: () => void }).dispose?.()
    }
  }

  private runTopLevelValidators(): void {
    if (this.disposed) return
    const value = this.value.value
    this.currentValidatorAbort?.abort()
    const abort = new AbortController()
    this.currentValidatorAbort = abort
    const myId = ++this.currentValidatorRun

    const syncErrors: string[] = []
    const asyncPromises: Promise<string | null>[] = []
    for (const v of this.validators) {
      try {
        const r = v(value, abort.signal)
        if (r instanceof Promise) asyncPromises.push(r)
        else if (r != null) syncErrors.push(r)
      } catch (err) {
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
        this.topLevelErrors$.set(syncErrors)
        this.topLevelValidating$.set(false)
      })
      return
    }

    if (asyncPromises.length === 0) {
      batch(() => {
        this.topLevelErrors$.set([])
        this.topLevelValidating$.set(false)
      })
      return
    }

    batch(() => {
      this.topLevelErrors$.set([])
      this.topLevelValidating$.set(true)
    })

    Promise.allSettled(asyncPromises).then((results) => {
      if (myId !== this.currentValidatorRun || this.disposed) return
      const errs: string[] = []
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value != null) errs.push(r.value)
      }
      batch(() => {
        this.topLevelErrors$.set(errs)
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
 * caller — `ctx.form` / `ctx.fieldArray` in the controller — can register one
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
 * validators. Called by `ctx.form` / `ctx.fieldArray` so synchronous validator
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
    // unless `ctx.fieldArray` is wrapped to rebind — but the leaf items in the
    // typical pattern come from a user factory that constructs through
    // `createField` and is bound here by the parent traversal.)
    for (const item of node.items.value) {
      bindTreeValidatorErrorReporter(item, reporter)
    }
    return
  }
  bindFieldValidatorErrorReporter(node as Field<unknown>, reporter)
}

// Quiet unused-import linter without exporting these symbols publicly.
void createField
void untracked
void isField
