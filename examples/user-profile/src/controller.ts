// User profile controller — the "all business logic" half of the example.
//
// What this file shows:
// 1. A shared query keyed by user id (`userQuery`).
// 2. A controller that subscribes to the query and exposes a Zod-validated
//    form for editing.
// 3. A mutation that saves the form with an OPTIMISTIC update — the cache is
//    patched synchronously, rolled back on error, and reconciled on success.
//
// What's NOT in here: any React-specific code. This file is plain TypeScript
// and is exhaustively testable without a DOM.

import { type Ctx, createRoot, defineController, defineQuery, defineScope } from '@olas/core'
import { zodValidator } from '@olas/zod'
import { z } from 'zod'
import type { Api, User } from './api'

// ---------------------------------------------------------------------------
// Deps and scopes
// ---------------------------------------------------------------------------

// Augment AmbientDeps once so `ctx.deps.api` is typed everywhere.
declare module '@olas/core' {
  interface AmbientDeps {
    api: Api
  }
}

// A scope so descendants don't have to take currentUserId in props.
export const currentUserScope = defineScope<{ id: string }>({ name: 'currentUser' })

// ---------------------------------------------------------------------------
// Shared query — module scope so the cache key is stable across consumers.
// ---------------------------------------------------------------------------

export const userQuery = defineQuery({
  key: (id: string) => [id],
  fetcher: async (id: string, signal: AbortSignal): Promise<User> => {
    // The fetcher receives any deps via closure — but in this example we want
    // a single shared query, so we pluck the api from a module-level reference.
    // In a real app, prefer wiring this through a small per-root QueryClient
    // bootstrap or, more idiomatically, capture an api injected via a
    // factory like `makeUserQuery(api)`.
    const api = currentApi
    if (api === undefined) throw new Error('userQuery: api not set; call setUserQueryApi first')
    return api.getUser(id, signal)
  },
  staleTime: 30_000,
})

let currentApi: Api | undefined
export function setUserQueryApi(api: Api): void {
  currentApi = api
}

// ---------------------------------------------------------------------------
// Profile schema (Zod) — drives both validators and the typed form value.
// ---------------------------------------------------------------------------

export const profileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(80, 'Too long'),
  email: z.string().email('Invalid email'),
})

// ---------------------------------------------------------------------------
// Profile controller — per-user page state.
// ---------------------------------------------------------------------------

export const userProfileController = defineController((ctx: Ctx, props: { userId: string }) => {
  const user = ctx.use(userQuery, () => [props.userId])

  // Build the form with `ctx.form` and per-field `zodValidator(...)`. We
  // could also use `formFromZod(ctx, profileSchema)` from @olas/zod — that's
  // a one-liner equivalent that walks the schema for us. The explicit form
  // here is shown so the field-type inference is fully precise and the
  // wiring is visible end-to-end.
  const form = ctx.form({
    name: ctx.field<string>('', [zodValidator(profileSchema.shape.name)]),
    email: ctx.field<string>('', [zodValidator(profileSchema.shape.email)]),
  })

  // Reactive seed: whenever the query loads (or the user changes), reset
  // the form to server values *unless* the user is dirty.
  ctx.effect(() => {
    const u = user.data.value
    if (u === undefined) return
    if (form.isDirty.value) return
    form.set({ name: u.name, email: u.email })
  })

  const save = ctx.mutation<void, User>({
    mutate: async (_: void, signal) => {
      form.markAllTouched()
      const valid = await form.validate()
      if (!valid) throw new Error('Invalid form')
      const { name, email } = form.value.value
      return ctx.deps.api.updateUser(props.userId, { name, email }, signal)
    },
    onMutate: () => {
      // Optimistic update: patch the shared query so any sibling that reads
      // `userQuery` sees the new values immediately. Returning the Snapshot
      // makes rollback automatic on error (spec §6.4).
      const { name, email } = form.value.value
      return userQuery.setData(props.userId, (prev: User | undefined): User => {
        if (prev === undefined) {
          return { id: props.userId, name, email }
        }
        return { ...prev, name, email }
      })
    },
    onSuccess: () => {
      // Reconcile against server truth.
      userQuery.invalidate(props.userId)
    },
  })

  return { user, form, save }
})

// ---------------------------------------------------------------------------
// Root — composes the profile controller into a no-props root.
// ---------------------------------------------------------------------------

export function createAppRoot(userId: string, api: Api) {
  setUserQueryApi(api)

  const appController = defineController((ctx) => ({
    profile: ctx.child(userProfileController, { userId }),
  }))

  return createRoot(appController, { deps: { api } })
}
