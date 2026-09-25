import type { Field } from '../controller/types'
import type { ReadSignal } from '../signals/types'
import type { ValidateOn } from './field'
import type { Validator } from './types'

/**
 * What `createForm` takes: an object of fields, nested forms and field arrays.
 * Its keys name the form's value, its errors and the paths `setErrors` takes.
 */
export type FormSchema = {
  [key: string]: Field<any> | Form<any> | FieldArray<any>
}

/**
 * The plain value of a `Form<S>`, under the schema's keys: a field's `T`, a
 * nested form's `FormValue` and a field array's array of item values.
 */
export type FormValue<S extends FormSchema> = {
  [K in keyof S]: S[K] extends Field<infer T>
    ? T
    : S[K] extends Form<infer SS>
      ? FormValue<SS>
      : S[K] extends FieldArray<infer I>
        ? FieldArrayValue<I>
        : never
}

/**
 * The errors of a `Form<S>`, in the schema's shape: `string[] | undefined` for
 * a field, a nested `FormErrors` for a nested form, and one entry per item for
 * a field array. Every key is optional.
 */
export type FormErrors<S extends FormSchema> = {
  [K in keyof S]?: S[K] extends Field<any>
    ? string[] | undefined
    : S[K] extends Form<infer SS>
      ? FormErrors<SS>
      : S[K] extends FieldArray<infer I>
        ? Array<FieldArrayItemErrors<I> | undefined>
        : never
}

/**
 * The value of a `FieldArray<I>`: `T[]` for `Field<T>` items, and
 * `FormValue<S>[]` for `Form<S>` items.
 */
export type FieldArrayValue<I> =
  I extends Field<infer T> ? T[] : I extends Form<infer S> ? FormValue<S>[] : never

/** The errors of one field-array item: `string[]` for a field, `FormErrors<S>` for a form. */
export type FieldArrayItemErrors<I> =
  I extends Field<any> ? string[] : I extends Form<infer S> ? FormErrors<S> : never

/**
 * What seeds one field-array item: the field's `T`, or a `DeepPartial` of the
 * form's value. `add` and `insert` pass it to the item factory.
 */
export type ItemInitial<I> =
  I extends Field<infer T> ? T : I extends Form<infer S> ? DeepPartial<FormValue<S>> : never

/**
 * `T` with every property optional, at every depth. An array becomes a
 * `ReadonlyArray` of deep-partial items. `Form.set` and a form's `initial` take
 * it, so a caller names only the leaves it writes.
 */
export type DeepPartial<T> = T extends object
  ? T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T

/**
 * A form-level validator, for rules across fields. It sees the whole
 * `FormValue<S>`. A `string` result lands in the form's `topLevelErrors`, and
 * a `FormIssue[]` routes each message to the field its `path` names.
 */
export type FormValidator<S extends FormSchema> = Validator<FormValue<S>>

/**
 * An array-level validator, for rules such as "at least one item". It sees
 * every item's value. A `string` result lands in the array's `topLevelErrors`,
 * and a `FormIssue[]` routes each message by its `path`, item index first.
 */
export type FieldArrayValidator<I> = Validator<FieldArrayValue<I>>

/** Options for `createForm(ctx, schema, options?)`. */
export type FormOptions<S extends FormSchema> = {
  /**
   * Initial values for the form. A function form is **tracked** — if the
   * function reads reactive signals (e.g. a query's `data`), the form re-seats
   * itself when those signals change, but only while the form is not dirty
   * (so a user mid-edit isn't clobbered by a background refetch). See
   * `resetOnInitialChange` for opt-out. Spec §8.4.
   */
  initial?: (() => DeepPartial<FormValue<S>> | undefined) | DeepPartial<FormValue<S>>
  /**
   * Form-level validators, which see the whole value.
   */
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

/** Options for `createField(ctx, initial, options?)`. */
export type FieldOptions<T> = {
  validators?: ReadonlyArray<Validator<T>>
  /**
   * When validation first runs: `'change'` (default) at once, `'blur'` after
   * the first `markTouched()`, `'submit'` after the first `revalidate()` or
   * `Form.validate()`. Once it has run, every change re-validates.
   */
  validateOn?: ValidateOn
}

/** Options for `createFieldArray(ctx, itemFactory, options?)`. */
export type FieldArrayOptions<I> = {
  /**
   * One item per entry, each built by the item factory from its value.
   */
  initial?: Array<ItemInitial<I>>
  /**
   * Array-level validators, which see every item's value.
   */
  validators?: FieldArrayValidator<I>[]
}

/**
 * What `Form.submit` resolves with. `ok: true` carries the handler's result.
 * `ok: false` names why the handler did not succeed:
 *  - `'invalid'` — pre-submit validation failed; every leaf is marked touched.
 *  - `'error'` — the handler threw; `error` is the thrown value.
 *  - `'busy'` — a submission was already in flight, so this one did not start.
 *  - `'disposed'` — the form was disposed.
 */
export type SubmitResult<R> =
  | { readonly ok: true; readonly data: R }
  | { readonly ok: false; readonly reason: 'invalid' | 'busy' | 'disposed' }
  | { readonly ok: false; readonly reason: 'error'; readonly error: unknown }

/** Options for `Form.submit`. */
export type SubmitOptions = {
  /**
   * Run `validate()` first and skip the handler when invalid. Default `true`.
   */
  validateBeforeSubmit?: boolean
  /**
   * Call `reset()` after the handler resolves. Default `false`.
   */
  resetOnSuccess?: boolean
  /**
   * `'capture'` (default) resolves `{ ok: false, reason: 'error' }` when the
   * handler throws. `'rethrow'` rejects with the thrown value instead.
   */
  onError?: 'rethrow' | 'capture'
}

/**
 * A nested form. Created via `createForm(ctx, schema, options?)`. Spec §8, §20.7.
 *
 * A form is a `ReadSignal` of its aggregate value, like a `Field`: `form.value`
 * is the structurally-typed `FormValue<S>`, and `form.subscribe` fires when
 * any leaf changes. `errors` mirrors the value's shape with
 * `string[] | undefined`. `flatErrors` is a flattened view for rendering a
 * single error summary.
 */
export type Form<S extends FormSchema> = ReadSignal<FormValue<S>> & {
  readonly fields: { [K in keyof S]: S[K] }
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
  /**
   * Number of times `submit(...)` has been called. Bumps before the handler runs.
   */
  readonly submitCount: ReadSignal<number>
  /**
   * The thrown value from the most recent failed submission, if any.
   * Cleared at the start of each new `submit(...)` call and on `reset()`.
   * A validation failure ("submit blocked because the form is invalid") is
   * NOT a thrown error: `submitError` stays `undefined` after that clear, and
   * the returned promise resolves with `{ ok: false, reason: 'invalid' }`.
   */
  readonly submitError: ReadSignal<unknown>

  /**
   * Deep-merge a partial value into the form, batched.
   */
  set(partial: DeepPartial<FormValue<S>>): void
  /**
   * Load `partial` as the form's new baseline — the form-level
   * `Field.setAsInitial`. Every leaf `partial` names takes the value as its
   * initial, so `isDirty` stays false and a later `reset()` returns here.
   */
  setAsInitial(partial: DeepPartial<FormValue<S>>): void
  /**
   * Reset every leaf to its initial value.
   */
  reset(): void
  /**
   * Reset a named subtree to its initial. Path uses the same dotted /
   * bracket notation as `setErrors` / `flatErrors`. Unlike `Form.set({foo:
   * undefined})` (which is "leave alone"), this is the explicit
   * "clear this subtree" gesture. Pass `''` to reset the whole form.
   */
  clearSubtree(path: string): void
  /**
   * Mark every leaf as touched (so error messages appear).
   */
  markAllTouched(): void
  /**
   * Re-run every leaf's validators. Resolves with true if all leaves are valid.
   */
  validate(): Promise<boolean>
  /**
   * Run a submission. Pre-validates the form (unless `validateBeforeSubmit: false`),
   * then calls `handler(value)`. Maintains `isSubmitting` / `submitCount` /
   * `submitError`. Resolves with a `SubmitResult`: switch on `ok`, then on
   * `reason`.
   */
  submit<R = unknown>(
    handler: (value: FormValue<S>) => R | Promise<R>,
    options?: SubmitOptions,
  ): Promise<SubmitResult<Awaited<R>>>
  /**
   * Pin externally-sourced errors on specific fields. Keys are dot-separated
   * paths through nested forms / field arrays (numeric segments are array
   * indices). Errors land in each field's `serverErrors` channel — kept
   * separate from validator output and auto-cleared on the next user write.
   */
  setErrors(errors: Record<string, ReadonlyArray<string>>): void
  /**
   * Idempotent. Called by the owning controller's dispose.
   */
  dispose(): void
}

/**
 * A dynamically-sized list of `Field` or `Form` items. Created via
 * `createFieldArray(ctx, itemFactory, options?)`. The factory is invoked per
 * insertion. Spec §8, §20.7.
 *
 * A field array is a `ReadSignal` of its items' values, like a `Field`:
 * `array.value` is `FieldArrayValue<I>`. `items` holds the item nodes.
 */
export type FieldArray<I extends Field<any> | Form<any>> = ReadSignal<FieldArrayValue<I>> & {
  readonly items: ReadSignal<ReadonlyArray<I>>
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

  /**
   * Write `values` into the array. Items at overlapping indices keep their
   * identity and take the value through their own `set`, so touched state and
   * in-flight validators survive. Extra values are appended; extra items are
   * removed.
   */
  set(values: ReadonlyArray<ItemInitial<I>>): void
  /**
   * Load `values` as the array's new baseline: the items are rebuilt from
   * them, `isDirty` stays false, and a later `reset()` returns here.
   */
  setAsInitial(values: ReadonlyArray<ItemInitial<I>>): void
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
