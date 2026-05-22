import type { Field } from '../controller/types'
import type { ReadSignal } from '../signals/types'
import type { Validator } from './types'

export type FormSchema = {
  [key: string]: Field<any> | Form<any> | FieldArray<any>
}

export type FormValue<S extends FormSchema> = {
  [K in keyof S]: S[K] extends Field<infer T>
    ? T
    : S[K] extends Form<infer SS>
      ? FormValue<SS>
      : S[K] extends FieldArray<infer I>
        ? FieldArrayValue<I>
        : never
}

export type FormErrors<S extends FormSchema> = {
  [K in keyof S]?: S[K] extends Field<any>
    ? string[] | undefined
    : S[K] extends Form<infer SS>
      ? FormErrors<SS>
      : S[K] extends FieldArray<infer I>
        ? Array<FieldArrayItemErrors<I> | undefined>
        : never
}

export type FieldArrayValue<I> =
  I extends Field<infer T> ? T[] : I extends Form<infer S> ? FormValue<S>[] : never

export type FieldArrayItemErrors<I> =
  I extends Field<any> ? string[] : I extends Form<infer S> ? FormErrors<S> : never

export type ItemInitial<I> =
  I extends Field<infer T> ? T : I extends Form<infer S> ? DeepPartial<FormValue<S>> : never

export type DeepPartial<T> = T extends object
  ? T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T

export type FormValidator<S extends FormSchema> = Validator<FormValue<S>>
export type FieldArrayValidator<I> = Validator<FieldArrayValue<I>>

export type FormOptions<S extends FormSchema> = {
  /**
   * Initial values for the form. A function form is **tracked** — if the
   * function reads reactive signals (e.g. a query's `data`), the form re-seats
   * itself when those signals change, but only while the form is not dirty
   * (so a user mid-edit isn't clobbered by a background refetch). See
   * `resetOnInitialChange` for opt-out. Spec §8.4.
   */
  initial?: (() => DeepPartial<FormValue<S>> | undefined) | DeepPartial<FormValue<S>>
  validators?: FormValidator<S>[]
  /**
   * When `initial` is a function and one of its tracked deps changes:
   *  - `'when-clean'` (default) — re-seat only if the form is not dirty.
   *  - `'never'` — never re-seat; `initial()` runs once at construction.
   *  - `'always'` — re-seat unconditionally (dirty state is discarded).
   *
   * Spec §20.7.
   */
  resetOnInitialChange?: 'when-clean' | 'never' | 'always'
}

export type FieldArrayOptions<I> = {
  initial?: Array<ItemInitial<I>>
  validators?: FieldArrayValidator<I>[]
}

/**
 * A nested form. Created via `ctx.form(schema, options?)`. `value` aggregates
 * every leaf into the structurally-typed `FormValue<S>`; `errors` mirrors that
 * shape with `string[] | undefined`. `flatErrors` is a flattened view useful
 * for rendering a single error summary. Spec §8, §20.7.
 *
 * IMPORTANT: `Form.value` is a `ReadSignal<FormValue<S>>` while `Field.value`
 * is `T` directly — different shapes. See `.wiki/pitfalls/field-value-shape.md`.
 */
export type Form<S extends FormSchema> = {
  readonly fields: { [K in keyof S]: S[K] }
  readonly value: ReadSignal<FormValue<S>>
  readonly errors: ReadSignal<FormErrors<S>>
  readonly topLevelErrors: ReadSignal<string[]>
  readonly flatErrors: ReadSignal<Array<{ path: string; errors: string[] }>>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  /**
   * Dotted paths of every leaf whose `isDirty` is true. Useful for PATCH
   * payloads and "highlight changed inputs" UIs. Field paths use dot
   * notation; array items use bracket notation (`items[0].title`).
   */
  readonly dirtyFields: ReadSignal<string[]>

  /**
   * `true` while a `submit(...)` is in flight. Clears when the handler
   * resolves, throws, or pre-submit validation fails.
   */
  readonly isSubmitting: ReadSignal<boolean>
  /** Number of times `submit(...)` has been called. Bumps before the handler runs. */
  readonly submitCount: ReadSignal<number>
  /**
   * The thrown value from the most recent failed submission, if any.
   * Cleared at the start of each new `submit(...)` call and on `reset()`.
   * Note that a validation failure ("submit blocked because the form is
   * invalid") is NOT a thrown error — `submitError` stays whatever it
   * was, and the returned promise resolves with `{ ok: false }`.
   */
  readonly submitError: ReadSignal<unknown>

  /** Deep-merge a partial value into the form, batched. */
  set(partial: DeepPartial<FormValue<S>>): void
  /**
   * Re-seat the form's leaves from `partial` as their new initials —
   * each leaf calls `setAsInitial(value)`, so `isDirty` stays false and a
   * subsequent `reset()` returns *here*. Internal-ish but exported for
   * `Form`-traversal code (nested-form initial application).
   */
  resetWithInitial(partial: DeepPartial<FormValue<S>>): void
  /** Reset every leaf to its initial value. */
  reset(): void
  /** Mark every leaf as touched (so error messages appear). */
  markAllTouched(): void
  /** Re-run every leaf's validators. Resolves with true if all leaves are valid. */
  validate(): Promise<boolean>
  /**
   * Run a submission. Pre-validates the form (unless `validateBeforeSubmit: false`),
   * then calls `handler(value)`. Maintains `isSubmitting` / `submitCount` /
   * `submitError`. Returns `{ ok, data?, error? }` — see `FormImpl.submit`
   * for the full contract.
   */
  submit<R = unknown>(
    handler: (value: FormValue<S>) => R | Promise<R>,
    options?: {
      validateBeforeSubmit?: boolean
      resetOnSuccess?: boolean
      onError?: 'rethrow' | 'capture'
    },
  ): Promise<{ ok: boolean; data?: Awaited<R>; error?: unknown }>
  /**
   * Pin externally-sourced errors on specific fields. Keys are dot-separated
   * paths through nested forms / field arrays (numeric segments are array
   * indices). Errors land in each field's `serverErrors` channel — kept
   * separate from validator output and auto-cleared on the next user write.
   */
  setErrors(errors: Record<string, ReadonlyArray<string>>): void
  /** Idempotent. Called by the owning controller's dispose. */
  dispose(): void
}

/**
 * A dynamically-sized list of `Field` or `Form` items. Created via
 * `ctx.fieldArray(itemFactory, options?)`. The factory is invoked per
 * insertion. Spec §8, §20.7.
 */
export type FieldArray<I extends Field<any> | Form<any>> = {
  readonly items: ReadSignal<ReadonlyArray<I>>
  readonly value: ReadSignal<FieldArrayValue<I>>
  readonly errors: ReadSignal<Array<FieldArrayItemErrors<I> | undefined>>
  readonly topLevelErrors: ReadSignal<string[]>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly size: ReadSignal<number>

  add(initial?: ItemInitial<I>): void
  insert(index: number, initial?: ItemInitial<I>): void
  remove(index: number): void
  move(from: number, to: number): void
  at(index: number): I | undefined
  clear(): void

  reset(): void
  markAllTouched(): void
  validate(): Promise<boolean>
  dispose(): void
}

// Brand markers used by traversal logic to distinguish primitive types.
export const FORM_BRAND = Symbol.for('olas.form')
export const FIELD_ARRAY_BRAND = Symbol.for('olas.fieldArray')

export type FormBranded = { readonly [FORM_BRAND]: true }
export type FieldArrayBranded = { readonly [FIELD_ARRAY_BRAND]: true }
