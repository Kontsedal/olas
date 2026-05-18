// React UI for the user profile.
//
// What this file shows:
// 1. `OlasProvider` at the top — the root is created OUTSIDE React.
// 2. `useRoot()` resolves the typed api anywhere inside the provider.
// 3. `useQuery(subscription)` batches the 8 AsyncState signals into one
//    re-render trigger.
// 4. `useField(field)` does the same for a `Field<T>` and gives you a
//    one-destructure binding to an `<input>`.
// 5. The mutation's `isPending` / `error` signals drive a busy button.

import type { Field, ReadSignal } from '@olas/core'
import { OlasProvider, use, useField, useQuery, useRoot } from '@olas/react'
import type { ReactElement } from 'react'
import type { createAppRoot } from './controller'

type AppRoot = ReturnType<typeof createAppRoot>
type AppApi = AppRoot extends infer R
  ? Omit<R, 'dispose' | 'suspend' | 'resume' | 'dehydrate' | 'waitForIdle' | '__debug'>
  : never

export function App({ root }: { root: AppRoot }): ReactElement {
  return (
    <OlasProvider root={root}>
      <UserProfileCard />
    </OlasProvider>
  )
}

function UserProfileCard(): ReactElement {
  const api = useRoot<AppApi>()
  const { data: user, isLoading, error } = useQuery(api.profile.user)

  if (isLoading) return <div>Loading…</div>
  if (error !== undefined) return <div role="alert">Failed to load: {String(error)}</div>
  if (user === undefined) return <div>No data</div>

  return (
    <article>
      <header>
        <h1>{user.name}</h1>
        <p>{user.email}</p>
      </header>
      <EditForm
        nameField={api.profile.form.fields.name}
        emailField={api.profile.form.fields.email}
        isPending={api.profile.save.isPending}
        run={api.profile.save.run}
      />
    </article>
  )
}

function EditForm(props: {
  nameField: Field<string>
  emailField: Field<string>
  isPending: ReadSignal<boolean>
  run: () => Promise<unknown>
}): ReactElement {
  const name = useField(props.nameField)
  const email = useField(props.emailField)
  const pending = use(props.isPending)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void props.run()
      }}
    >
      <label>
        Name
        <input
          value={name.value}
          onChange={(e) => name.set(e.target.value)}
          onBlur={name.markTouched}
          aria-invalid={name.errors.length > 0 ? true : undefined}
        />
        {name.touched && name.errors[0] !== undefined && <span role="alert">{name.errors[0]}</span>}
      </label>
      <label>
        Email
        <input
          type="email"
          value={email.value}
          onChange={(e) => email.set(e.target.value)}
          onBlur={email.markTouched}
          aria-invalid={email.errors.length > 0 ? true : undefined}
        />
        {email.touched && email.errors[0] !== undefined && (
          <span role="alert">{email.errors[0]}</span>
        )}
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
