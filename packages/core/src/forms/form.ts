import type { Field } from '../controller/types'
import { type Signal, batch, computed, effect, signal, untracked } from '../signals'
import type { ReadSignal } from '../signals/types'
import { bindFieldDevtoolsOwner, createField } from './field'
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

  private readonly validators: ReadonlyArray<FormValidator<S>>
  private readonly options: FormOptions<S> | undefined
  private validatorDispose: (() => void) | null = null
  private currentValidatorRun = 0
  private currentValidatorAbort: AbortController | null = null
  private disposed = false

  constructor(schema: S, options?: FormOptions<S>) {
    this.fields = schema
    this.options = options
    this.validators = options?.validators ?? []

    // Apply initial values (one-shot or initial snapshot from a function).
    if (options?.initial !== undefined) {
      const ini = typeof options.initial === 'function' ? options.initial() : options.initial
      if (ini !== undefined) this.applyPartial(ini as DeepPartial<FormValue<S>>)
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
    batch(() => this.applyPartial(partial))
  }

  private applyPartial(partial: DeepPartial<FormValue<S>>): void {
    for (const [k, val] of Object.entries(partial)) {
      const child = (this.fields as Record<string, unknown>)[k]
      if (!child) continue
      if (isForm(child)) {
        child.set(val as DeepPartial<FormValue<FormSchema>>)
      } else if (isFieldArray(child)) {
        const arr = child
        // Replace items: clear, then add each
        arr.clear()
        for (const itemVal of val as unknown[]) {
          arr.add(itemVal as ItemInitial<Field<unknown>>)
        }
      } else {
        ;(child as Field<unknown>).set(val)
      }
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
      this.topLevelErrors$.set([])
    })
    // Re-apply initial if provided.
    if (this.options?.initial !== undefined) {
      const ini =
        typeof this.options.initial === 'function' ? this.options.initial() : this.options.initial
      if (ini !== undefined) this.applyPartial(ini as DeepPartial<FormValue<S>>)
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.validatorDispose?.()
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
      const r = v(value, abort.signal)
      if (r instanceof Promise) asyncPromises.push(r)
      else if (r != null) syncErrors.push(r)
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
  private readonly initialItems: Array<ItemInitial<I>> = []
  private readonly validators: ReadonlyArray<FieldArrayValidator<I>>
  private currentValidatorRun = 0
  private currentValidatorAbort: AbortController | null = null
  private validatorDispose: (() => void) | null = null
  private disposed = false

  constructor(itemFactory: (initial?: ItemInitial<I>) => I, options?: FieldArrayOptions<I>) {
    this.itemFactory = itemFactory
    this.validators = options?.validators ?? []
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
      const r = v(value, abort.signal)
      if (r instanceof Promise) asyncPromises.push(r)
      else if (r != null) syncErrors.push(r)
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

export function createForm<S extends FormSchema>(schema: S, options?: FormOptions<S>): Form<S> {
  return new FormImpl(schema, options)
}

export function createFieldArray<I extends Field<any> | Form<any>>(
  itemFactory: (initial?: ItemInitial<I>) => I,
  options?: FieldArrayOptions<I>,
): FieldArray<I> {
  return new FieldArrayImpl<I>(itemFactory, options)
}

/**
 * Recursively wire every leaf `Field` in a form / field-array tree to a
 * devtools emitter. The supplied `pathBuilder` decides the field's display
 * name within the form ("title" vs "subtasks[0].text"). Internal — called by
 * `ctx.form` / `ctx.fieldArray` so the devtools panel knows what fields exist.
 */
export function bindTreeToDevtools(
  node: Field<unknown> | Form<FormSchema> | FieldArray<Field<unknown> | Form<FormSchema>>,
  prefix: string,
  controllerPath: readonly string[],
  emitter: import('../devtools').DevtoolsEmitter,
): void {
  if (isForm(node)) {
    for (const [key, child] of Object.entries(node.fields)) {
      bindTreeToDevtools(child, prefix === '' ? key : `${prefix}.${key}`, controllerPath, emitter)
    }
    return
  }
  if (isFieldArray(node)) {
    // Re-bind on every items change so dynamically-added entries get tracked.
    const arr = node as FieldArray<Field<unknown> | Form<FormSchema>>
    effect(() => {
      const items = arr.items.value
      items.forEach((item, idx) => {
        bindTreeToDevtools(item, `${prefix}[${idx}]`, controllerPath, emitter)
      })
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

// Quiet unused-import linter without exporting these symbols publicly.
void createField
void untracked
void isField
