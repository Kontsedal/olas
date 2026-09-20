import { ctxInternals } from '../controller/internals'
import type { Ctx, Field } from '../controller/types'
import type { DevtoolsEmitter } from '../devtools'
import { bindFieldDevtoolsOwner, createField as createFieldImpl } from './field'
import {
  bindTreeToDevtools,
  bindTreeValidatorErrorReporter,
  createFieldArray as createFieldArrayImpl,
  createForm as createFormImpl,
} from './form'
import type {
  FieldArray,
  FieldArrayOptions,
  Form,
  FormOptions,
  FormSchema,
  ItemInitial,
} from './form-types'
import type { Validator } from './types'

/**
 * A reactive form field owned by this controller's lifetime (§8.1).
 *
 * ```ts
 * const email = createField(ctx, '', [required('Required')])
 * ```
 *
 * Was `ctx.field(...)`. It moved off `Ctx` so that a controller which never
 * builds a field does not ship the forms subsystem — see
 * `.wiki/decisions/ctx-primitives-are-free-functions.md`.
 */
export function createField<T>(
  ctx: Ctx,
  initial: T,
  validators?: ReadonlyArray<Validator<T>>,
  options?: { validateOn?: 'change' | 'blur' | 'submit' },
): Field<T> {
  const internals = ctxInternals(ctx, 'createField')
  internals.assertLive('createField')
  // The reporter is passed at construct time so the FIRST validator pass —
  // which runs synchronously inside the FieldImpl constructor's effect — is
  // covered.
  const field = createFieldImpl(initial, validators, {
    onValidatorError: (err) => internals.report(err, 'effect'),
    validateOn: options?.validateOn,
  })
  internals.register({ kind: 'cleanup', dispose: () => field.dispose() })
  // A standalone field still publishes `field:validated`. The devtools panel
  // groups by controller path, so the placeholder name is fine.
  bindFieldDevtoolsOwner(field, {
    controllerPath: internals.path,
    fieldName: '(field)',
    emitter: internals.devtools as DevtoolsEmitter,
  })
  return field
}

/**
 * A form aggregating fields, nested forms and field arrays (§8.3).
 *
 * ```ts
 * const form = createForm(ctx, { email, password })
 * ```
 *
 * Was `ctx.form(...)`.
 */
export function createForm<S extends FormSchema>(
  ctx: Ctx,
  schema: S,
  options?: FormOptions<S>,
): Form<S> {
  const internals = ctxInternals(ctx, 'createForm')
  internals.assertLive('createForm')
  const reporter = (err: unknown): void => internals.report(err, 'effect')
  const form = createFormImpl(schema, options, { onValidatorError: reporter })
  internals.register({ kind: 'cleanup', dispose: () => form.dispose() })
  // Every leaf publishes `field:validated` with its key path inside the form
  // (§20.9).
  const stop = bindTreeToDevtools(
    form as unknown as Form<FormSchema>,
    '',
    internals.path,
    internals.devtools as DevtoolsEmitter,
  )
  internals.register({ kind: 'cleanup', dispose: stop })
  // Nested forms and arrays inside the schema were constructed by the caller
  // before this ran, so they never received the reporter. Idempotent for
  // leaves that already have it.
  bindTreeValidatorErrorReporter(form as unknown as Form<FormSchema>, reporter)
  return form
}

/**
 * A dynamic list of fields or forms (§8.5).
 *
 * ```ts
 * const lines = createFieldArray(ctx, () => createField(ctx, ''))
 * ```
 *
 * Was `ctx.fieldArray(...)`.
 */
export function createFieldArray<I extends Field<any> | Form<any>>(
  ctx: Ctx,
  itemFactory: (initial?: ItemInitial<I>) => I,
  options?: FieldArrayOptions<I>,
): FieldArray<I> {
  const internals = ctxInternals(ctx, 'createFieldArray')
  internals.assertLive('createFieldArray')
  const reporter = (err: unknown): void => internals.report(err, 'effect')
  const array = createFieldArrayImpl<I>(itemFactory, options, { onValidatorError: reporter })
  internals.register({ kind: 'cleanup', dispose: () => array.dispose() })
  const stop = bindTreeToDevtools(
    array as unknown as FieldArray<Field<unknown> | Form<FormSchema>>,
    '',
    internals.path,
    internals.devtools as DevtoolsEmitter,
  )
  internals.register({ kind: 'cleanup', dispose: stop })
  bindTreeValidatorErrorReporter(
    array as unknown as FieldArray<Field<unknown> | Form<FormSchema>>,
    reporter,
  )
  return array
}
