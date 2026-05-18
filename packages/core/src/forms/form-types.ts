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

export type FieldArrayValue<I> = I extends Field<infer T>
  ? T[]
  : I extends Form<infer S>
    ? FormValue<S>[]
    : never

export type FieldArrayItemErrors<I> = I extends Field<any>
  ? string[]
  : I extends Form<infer S>
    ? FormErrors<S>
    : never

export type ItemInitial<I> = I extends Field<infer T>
  ? T
  : I extends Form<infer S>
    ? DeepPartial<FormValue<S>>
    : never

export type DeepPartial<T> = T extends object
  ? T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T

export type FormValidator<S extends FormSchema> = Validator<FormValue<S>>
export type FieldArrayValidator<I> = Validator<FieldArrayValue<I>>

export type FormOptions<S extends FormSchema> = {
  initial?: (() => DeepPartial<FormValue<S>> | undefined) | DeepPartial<FormValue<S>>
  validators?: FormValidator<S>[]
}

export type FieldArrayOptions<I> = {
  initial?: Array<ItemInitial<I>>
  validators?: FieldArrayValidator<I>[]
}

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

  set(partial: DeepPartial<FormValue<S>>): void
  reset(): void
  markAllTouched(): void
  validate(): Promise<boolean>
  dispose(): void
}

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
