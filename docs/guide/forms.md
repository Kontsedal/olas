# Forms

Olas forms live in the controller, as signals. A field knows its value, errors, dirtiness and touched state. A form aggregates its fields with a value type inferred from the schema, and `submit` runs validate-then-send with a typed result. The view binds inputs and renders errors, and a test fills and submits a form without rendering anything.

The contract is SPEC [§8](https://github.com/Kontsedal/olas/blob/main/SPEC.md#8-fields-forms--validators). Full signatures are in the [API reference](/reference/olas-core.createform).

## The model

Three node types cover the form story:

```text
Form<S> ─┬─ Field<string>            one value, its validators and state
         ├─ Form<{ … }>              a nested group, addressed as form.fields.address
         └─ FieldArray<Form<{ … }>>  a dynamic list of fields or sub-forms
```

- **`Field<T>`** holds one value. `createField(ctx, initial, options)` creates it.
- **`Form<S>`** aggregates a schema of fields, forms and field arrays. `createForm(ctx, schema, options)` creates it.
- **`FieldArray<I>`** holds a list whose items a factory builds. `createFieldArray(ctx, factory, options)` creates it.

All three are `ReadSignal`s of their value, so `field.value`, `form.value` and `array.value` each read the value itself, and `useValue(form)` re-renders when any leaf changes. The [forms-are-read-signals decision](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/forms-are-read-signals.md) records why. The controller owns every node it creates, and disposing the controller disposes them.

The examples on this page share one service, typed through `AmbientDeps`:

```ts file=api.ts
// api.ts: the app's services, typed once for every controller
type Options = { signal: AbortSignal }

export type Profile = { id: string; name: string; email: string; username: string }
export type ProfileInput = { name: string; username: string }

export class ServerValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string[]>) {
    super('Validation failed')
  }
}

export type Api = {
  getProfile(id: string, options: Options): Promise<Profile>
  saveProfile(input: ProfileInput, options: Options): Promise<Profile>
  isUsernameTaken(name: string, options: Options): Promise<boolean>
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: Api
  }
}
```

## A field

```ts
import { createField, defineController, maxLength, minLength, required } from '@kontsedal/olas-core'

export const signup = defineController((ctx) => {
  const username = createField<string>(ctx, '', {
    validators: [required('Pick a username'), minLength(3), maxLength(20)],
  })
  return { username }
})
```

A [`Field<T>`](/reference/olas-core.field) carries five state signals and six actions:

| Signal | Meaning |
|---|---|
| `errors` | Validator messages, then server errors, then messages a form-level rule routed here. |
| `isValid` | `errors` is empty. While an async check runs, it holds its last settled value. |
| `isDirty` | The value differs from the initial one. Setting it back clears the flag. |
| `touched` | `markTouched()` has run, normally on blur. |
| `isValidating` | An async validator is pending. |

`set(value)` writes and re-validates. `reset()` restores the initial value and clears dirty, touched, the validator errors and the server errors. A message a form-level rule routed onto the field stays until that rule runs again. `markTouched()` records a blur. `revalidate()` re-runs the validators and resolves with the new `isValid`. `setAsInitial(value)` moves the baseline without marking the field dirty. `setErrors(messages)` pins server errors, covered [below](#server-errors).

**Annotate the type when you pass validators.** `createField` infers `T` from the initial value. With a `validators` array, `createField(ctx, '', { validators })` infers `Field<''>`, and the first `set('ada')` fails to compile far from the declaration. `createField(ctx, null)` gives a `Field<null>` for the same reason. Write `createField<string>(...)` and `createField<string | null>(...)`. The [literal-type pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/literal-type-narrowing.md) explains the inference.

## Validators

A validator is a function of the value and an `AbortSignal`. It returns a message, `null` for valid, or a promise of either:

| Built-in | Rejects |
|---|---|
| `required(message?)` | `''`, `null`, `undefined` and `[]`. A boolean `false` passes. |
| `mustBeTrue(message?)` | Anything but `true`. Use it for a consent checkbox. |
| `minLength(n, message?)`, `maxLength(n, message?)` | Strings and arrays outside the bound. |
| `min(n, message?)`, `max(n, message?)` | Numbers outside the bound. |
| `email(message?)` | A string that does not look like an email address. |
| `pattern(re, message?)` | A string that does not match `re`. |

`email` and `pattern` pass an empty string, and the length and number bounds pass `null` and `undefined`. Pair them with `required()` when the field is mandatory.

A validator runs in a tracking scope, so a signal it reads re-runs it on change:

<!-- snippet-prelude
import { createField, defineController, minLength } from '@kontsedal/olas-core'
-->
```ts
export const passwords = defineController((ctx) => {
  const password = createField<string>(ctx, '', { validators: [minLength(8)] })
  const confirm = createField<string>(ctx, '', {
    validators: [(value) => (value === password.value ? null : 'Passwords must match')],
  })
  return { password, confirm } // editing password re-runs confirm's check
})
```

The sync validators run first, and the async ones run only once every sync one passes. `validateOn` sets when validation first runs:

- `'change'` (default) validates at once and on every change.
- `'blur'` waits for the first `markTouched()`.
- `'submit'` waits for the first `revalidate()` or form `validate()`, which `submit` calls.

Once validation has run, every change re-validates. `reset()` locks a `'blur'` or `'submit'` field again.

## Async and debounced validators

`debouncedValidator(fn, ms)` wraps a server check so each keystroke does not send a request:

```ts
import { createField, debouncedValidator, defineController, required } from '@kontsedal/olas-core'

export const usernamePicker = defineController((ctx) => {
  const username = createField<string>(ctx, '', {
    validators: [
      required(),
      debouncedValidator<string>(async (name, signal) => {
        const taken = await ctx.deps.api.isUsernameTaken(name, { signal })
        return taken ? 'That name is taken' : null
      }, 400),
    ],
  })
  return { username }
})
```

A new value aborts the pending check through its `signal`, so pass the signal to the request. While the check waits or runs, `isValidating` is `true` and `isValid` holds its last settled value (§8.2). A submit button bound to `isValid` therefore does not flicker on every keystroke.

## A form

```ts file=profile-form.ts
import { createField, createForm, defineController, email, required } from '@kontsedal/olas-core'

export const profileForm = defineController((ctx) => {
  const form = createForm(ctx, {
    name: createField<string>(ctx, '', { validators: [required()] }),
    email: createField<string>(ctx, '', { validators: [required(), email()] }),
    address: createForm(ctx, {
      street: createField<string>(ctx, ''),
      city: createField<string>(ctx, '', { validators: [required()] }),
    }),
  })
  return { form }
})
```

`form.value` is typed from the schema: `{ name: string; email: string; address: { street: string; city: string } }`. Reach a leaf through `form.fields.address.fields.city`. The aggregate signals are:

- `errors`, shaped like the value, with `string[] | undefined` at each leaf.
- `flatErrors`, a list of `{ path, errors }` for an error summary at the top of the form.
- `isDirty`, `touched` and `isValidating`, each true when any leaf is.
- `isValid`, true when every leaf is valid and no form-level rule failed.
- `dirtyFields`, the paths of the dirty leaves, such as `address.city`, for a PATCH payload.
- `topLevelErrors`, the messages of form-level validators.

`set(partial)` deep-merges a partial value in one batch. `setAsInitial(partial)` loads a new baseline and leaves the form clean. `reset()` returns every leaf to its initial value. `clearSubtree('address')` resets one subtree. `markAllTouched()` reveals every error, and `validate()` runs every validator and resolves with the result.

### Cross-field rules

A rule that spans fields goes in the form's `validators` and sees the whole value. A returned string lands in `topLevelErrors`. A returned `FormIssue[]` routes each message to the field its `path` names:

<!-- snippet-prelude
import { createField, createForm, defineController, minLength } from '@kontsedal/olas-core'
-->
```ts
export const changePassword = defineController((ctx) => {
  const form = createForm(
    ctx,
    {
      password: createField<string>(ctx, '', { validators: [minLength(8)] }),
      confirm: createField<string>(ctx, ''),
    },
    {
      validators: [
        (v) => (v.password === v.confirm ? [] : [{ path: ['confirm'], message: 'Passwords must match' }]),
      ],
    },
  )
  return { form } // form.fields.confirm.errors holds the message
})
```

A routed message joins the field's `errors` and is recomputed on every form-level run, so fixing the mismatch removes it. Only that run writes it. A field's `reset()` or `setAsInitial()` that leaves the form's value unchanged does not re-run the rule, so its message stays, and so does a form's `topLevelErrors` through `form.reset()`. An empty path, or one that names no field, lands in `topLevelErrors`. `form.isValid` is `false` while any leaf is invalid or `topLevelErrors` is non-empty.

## Seed a form from server data

`initial` accepts a tracked thunk. Point it at a query, and the form fills when the data lands:

```ts
import { createField, createForm, createQuery, defineController, defineQuery, email, required } from '@kontsedal/olas-core'

const profileQuery = defineQuery({
  id: 'profile',
  key: (id: string) => ['profile', id],
  fetcher: ({ signal, deps }, id) => deps.api.getProfile(id, { signal }),
})

export const profileEditor = defineController((ctx, props: { userId: string }) => {
  const profile = createQuery(ctx, profileQuery, () => [props.userId])
  const form = createForm(
    ctx,
    {
      name: createField<string>(ctx, '', { validators: [required()] }),
      email: createField<string>(ctx, '', { validators: [required(), email()] }),
    },
    { initial: () => profile.data.value },
  )
  return { profile, form }
})
```

The form re-applies `initial()` when its signals change, but only while the form is clean (§8.4). A background refetch therefore cannot overwrite a user mid-edit. `resetOnInitialChange` changes the rule: `'never'` reads `initial()` once, and `'always'` re-seats a dirty form too. `reset()` re-reads `initial()` for the latest baseline.

## Lists: `createFieldArray`

A field array builds each item with a factory, which receives the value passed to `add` or `insert`:

```ts
import { createField, createFieldArray, createForm, defineController, min, required } from '@kontsedal/olas-core'

export const orderForm = defineController((ctx) => {
  const form = createForm(ctx, {
    customer: createField<string>(ctx, '', { validators: [required()] }),
    lines: createFieldArray(
      ctx,
      (initial?: { sku?: string; qty?: number }) =>
        createForm(ctx, {
          sku: createField<string>(ctx, initial?.sku ?? '', { validators: [required()] }),
          qty: createField<number>(ctx, initial?.qty ?? 1, { validators: [min(1)] }),
        }),
      {
        initial: [{ sku: '', qty: 1 }],
        validators: [(lines) => (lines.length > 0 ? null : 'Add at least one line')],
      },
    ),
  })
  return { form, addLine: () => form.fields.lines.add({ qty: 1 }) }
})
```

**The factory must use its argument.** `FieldArray.add(x)` hands `x` to the factory and trusts it. A factory written as `() => createField(ctx, '')` ignores `x`, so every added row starts empty (the [factory pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/fieldarray-factory-uses-initial.md)).

- `add`, `insert`, `remove`, `move` and `clear` change the structure. Each marks the array dirty, so a tracked form `initial` stops re-seating once the user adds or removes a row.
- `set(values)` writes through the items at overlapping indices, so they keep their touched state. `setAsInitial(values)` rebuilds the items as a clean baseline.
- `items`, `size` and `at(index)` read the item nodes. `value` reads their values.
- Array-level validators see the whole list. Their messages land in the array's `topLevelErrors`, and a `FormIssue` path starts with an item index.

Removing an item disposes it. `flatErrors` and `dirtyFields` name array items with brackets, such as `lines[0].sku`.

## Server errors

A failed save often returns field errors. `setErrors` pins them in a channel of their own:

<!-- snippet-prelude
import type { Field, FieldArray, Form } from '@kontsedal/olas-core'
type Line = Form<{ sku: Field<string> }>
declare const form: Form<{ username: Field<string>; lines: FieldArray<Line> }>
-->
```ts
form.fields.username.setErrors(['That name is taken'])
form.setErrors({ username: ['That name is taken'], 'lines.0.sku': ['Unknown SKU'] })
```

A form path uses dots through nested forms and a numeric segment for an array item, and `lines[0].sku` works too. A validator re-run leaves server errors in place. The user's next `set` on that field clears them, and so do `reset()`, `setAsInitial()` and `setErrors([])`.

## Submit

`form.submit(handler)` validates, calls the handler with the value and resolves a [`SubmitResult`](/reference/olas-core.submitresult). A mutation is the usual handler:

```ts
import { createField, createForm, createMutation, defineController, required } from '@kontsedal/olas-core'
import { type ProfileInput, ServerValidationError } from './api'

export const editProfile = defineController((ctx) => {
  const form = createForm(ctx, {
    name: createField<string>(ctx, '', { validators: [required()] }),
    username: createField<string>(ctx, '', { validators: [required()] }),
  })
  const save = createMutation(ctx, {
    id: 'profile/save',
    mutate: (input: ProfileInput, { signal, deps }) => deps.api.saveProfile(input, { signal }),
  })

  const submit = async (): Promise<string> => {
    const result = await form.submit((value) => save.run(value))
    if (result.ok) return `Saved ${result.data.name}`
    switch (result.reason) {
      case 'invalid':
        return 'Fix the highlighted fields' // every leaf is touched now
      case 'busy':
        return 'Already saving'
      case 'disposed':
        return 'The form is gone'
      case 'error':
        if (result.error instanceof ServerValidationError) form.setErrors(result.error.fieldErrors)
        return 'Could not save'
    }
  }
  return { form, submit }
})
```

| Result | When |
|---|---|
| `{ ok: true, data }` | The handler resolved, and `data` is its result. |
| `{ ok: false, reason: 'invalid' }` | Validation failed. The handler did not run, and every leaf is marked touched. |
| `{ ok: false, reason: 'error', error }` | The handler threw, and `error` is the thrown value. |
| `{ ok: false, reason: 'busy' }` | A submission was already in flight, so this one did not start. |
| `{ ok: false, reason: 'disposed' }` | The form was disposed. |

A union lets a caller tell "invalid" from "already submitting" without matching an error message. While a submission runs, `isSubmitting` is `true`. `submitCount` counts the submissions that started, and `submitError` holds what the last handler threw. `validateBeforeSubmit: false` skips validation, and `resetOnSuccess: true` calls `reset()` after the handler resolves. `onError: 'rethrow'` rejects with the thrown value instead of resolving `'error'`.

## Schema validators: Standard Schema and Zod

`validator(schema)` adapts any Standard Schema, such as Zod 4, Valibot 1 or ArkType 2, into a `Validator`. It returns every issue with its path. On a field the paths are empty, and the messages land on the field. As a form-level validator, each issue routes to the field its path names:

```ts
import { createField, createForm, defineController, validator } from '@kontsedal/olas-core'
import { z } from 'zod'

const signupSchema = z
  .object({ password: z.string().min(8), confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords must match' })

export const signupForm = defineController((ctx) => {
  const form = createForm(
    ctx,
    { password: createField<string>(ctx, ''), confirm: createField<string>(ctx, '') },
    { validators: [validator(signupSchema)] },
  )
  return { form }
})
```

`validator` does not forward the `AbortSignal`, because Standard Schema v1 has no cancellation. For a form whose whole structure comes from one Zod schema, `createZodForm` from [`@kontsedal/olas-zod`](/packages/zod) builds the fields, forms and arrays with their validators attached. It enforces the schema's rules on objects and arrays too, such as the refine above or `z.array(...).min(3)`, and each message lands on the node its path names. An array rule lands in the `FieldArray`'s `topLevelErrors`.

## In a React component

`@kontsedal/olas-react` binds fields and forms with hooks:

```tsx
import type { Field, Form } from '@kontsedal/olas-core'
import { useField, useFieldInput, useValue } from '@kontsedal/olas-react'

export function UsernameInput(props: { field: Field<string> }) {
  const input = useFieldInput(props.field, { name: 'username' })
  const { errors, touched, isValidating } = useField(props.field)
  return (
    <label>
      Username
      <input {...input} aria-describedby="username-error" />
      {isValidating && <span>Checking…</span>}
      {touched && errors[0] && <em id="username-error">{errors[0]}</em>}
    </label>
  )
}

export function SaveButton(props: { form: Form<{ username: Field<string> }> }) {
  const isValid = useValue(props.form.isValid)
  const isSubmitting = useValue(props.form.isSubmitting)
  return (
    <button type="submit" disabled={!isValid || isSubmitting}>
      Save
    </button>
  )
}
```

`useFieldInput` returns `value`, `onChange`, `onBlur`, `name` and `aria-invalid`, ready to spread onto a native `input`, `textarea` or `select`. Its `onBlur` calls `markTouched()`, so `validateOn: 'blur'` works with no extra wiring. A field whose value is not a string takes a `transform: { parse, format }`. `useField` returns the value, the five state flags and the actions. See [the React adapter](/adapters/react), and the [Vue](/adapters/vue) and [Svelte](/adapters/svelte) equivalents.

## Sharp edges

- **Literal inference.** `createField(ctx, '', { validators })` is a `Field<''>`. Annotate the type.
- **`add(x)` needs a factory that reads `x`.** The array passes the value to the factory and applies nothing itself.
- **Three error channels.** A field's own validators, routed form-level messages and server errors all merge into `errors`, and each clears on a different trigger.
- **`isValid` holds during async checks.** It changes only when a validation pass completes, so gate submission on `isValidating` too if a stale pass matters.
- **`reset()` re-locks validation.** A `'blur'` field shows no errors again until the next blur.

## See also

- Reference: [`createField`](/reference/olas-core.createfield), [`createForm`](/reference/olas-core.createform), [`createFieldArray`](/reference/olas-core.createfieldarray), [`Form`](/reference/olas-core.form), [`FieldArray`](/reference/olas-core.fieldarray), [`Validator`](/reference/olas-core.validator), [`debouncedValidator`](/reference/olas-core.debouncedvalidator) and [`useFieldInput`](/reference/olas-react.usefieldinput).
- [Recipes](/guide/recipes): `createSubmit`, validate-then-mutate as a composable, and `createInlineEdit` for click-to-edit cells.
- [Mutations](/guide/mutations) for the write behind `submit`.
