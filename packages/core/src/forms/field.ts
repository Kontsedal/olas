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
 * Hook attached by `ctx.form` (or `createForm`) so a Field can publish
 * `field:validated` devtools events with its owning controller path + the
 * field's name within the form schema. See devtools §20.9 and FieldImpl.bind.
 */
export type FieldDevtoolsOwner = {
  controllerPath: readonly string[]
  fieldName: string
  emitter: DevtoolsEmitter
}

class FieldImpl<T> implements Field<T> {
  private readonly value$: Signal<T>
  private readonly errors$: Signal<string[]>
  private readonly touched$: Signal<boolean>
  private readonly dirty$: Signal<boolean>
  private readonly validating$: Signal<boolean>
  private readonly isValid$: Computed<boolean>
  private readonly revalidateTrigger$: Signal<number>

  private readonly validators: ReadonlyArray<Validator<T>>
  private readonly initial: T
  private validatorDispose: (() => void) | null = null
  private currentAbort: AbortController | null = null
  private runId = 0
  private disposed = false
  private devtoolsOwner: FieldDevtoolsOwner | null = null

  constructor(initial: T, validators: ReadonlyArray<Validator<T>> = []) {
    this.initial = initial
    this.validators = validators
    this.value$ = signal(initial)
    this.errors$ = signal<string[]>([])
    this.touched$ = signal(false)
    this.dirty$ = signal(false)
    this.validating$ = signal(false)
    this.revalidateTrigger$ = signal(0)
    this.isValid$ = computed(() => this.errors$.value.length === 0 && !this.validating$.value)

    if (validators.length > 0) {
      this.validatorDispose = effect(() => {
        this.runValidators()
      })
    }
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
    this.value$.set(value)
    this.dirty$.set(true)
  }

  reset(): void {
    if (this.disposed) return
    this.currentAbort?.abort()
    this.currentAbort = null
    batch(() => {
      this.value$.set(this.initial)
      this.dirty$.set(false)
      this.touched$.set(false)
      this.errors$.set([])
      this.validating$.set(false)
    })
  }

  markTouched(): void {
    if (this.disposed) return
    this.touched$.set(true)
  }

  async revalidate(): Promise<boolean> {
    if (this.disposed) return this.isValid$.peek()
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

    // Abort previous in-flight run.
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort
    const myId = ++this.runId

    const syncErrors: string[] = []
    const asyncPromises: Promise<string | null>[] = []

    for (const validator of this.validators) {
      const result = validator(value, abort.signal)
      if (result instanceof Promise) {
        asyncPromises.push(result)
      } else if (result != null) {
        syncErrors.push(result)
      }
    }

    if (syncErrors.length > 0) {
      batch(() => {
        this.errors$.set(syncErrors)
        this.validating$.set(false)
      })
      this.emitValidated(false, syncErrors)
      return
    }

    if (asyncPromises.length === 0) {
      batch(() => {
        this.errors$.set([])
        this.validating$.set(false)
      })
      this.emitValidated(true, [])
      return
    }

    batch(() => {
      this.errors$.set([])
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
        this.errors$.set(asyncErrors)
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

export function createField<T>(initial: T, validators?: ReadonlyArray<Validator<T>>): Field<T> {
  return new FieldImpl(initial, validators)
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
