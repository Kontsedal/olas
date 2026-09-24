import type { Transform } from '../types'
import { asyncState } from './async-state'
import { createField } from './create-field'
import { ctxPrimitives } from './ctx-primitives'
import { entities } from './entities'
import { errorContext } from './error-context'
import { forms } from './forms'
import { identityMeta } from './identity-meta'
import { mutateContext } from './mutate-context'
import { mutationQueue } from './mutation-queue'
import { persist } from './persist'
import { reactMutation } from './react-mutation'
import { removedApis } from './removed-apis'
import { renames } from './renames'
import { rootApi } from './root-api'
import { rootOptions } from './root-options'
import { suspendOptions } from './suspend-options'
import { useController } from './use-controller'

/**
 * Every 0.8 → 1.0 transform, in the order they must run.
 *
 * The type-driven transforms run first, on code that still resolves the 0.8
 * types. A rewrite to a 1.0 name leaves an expression the 0.8 declarations
 * cannot type: after `ctx.form(...)` becomes `createForm(ctx, ...)`, the
 * form's type is gone, and `forms` could no longer find `form.value.value`.
 * `root-api` is the last of them, because a `root.api.x` it writes has no
 * 0.8 type either. `use-controller` runs after `root-api`, so the `.api` it
 * writes is not rewritten again.
 */
export const transforms: readonly Transform[] = [
  forms,
  asyncState,
  reactMutation,
  suspendOptions,
  errorContext,
  entities,
  mutationQueue,
  removedApis,
  rootApi,
  ctxPrimitives,
  createField,
  identityMeta,
  mutateContext,
  rootOptions,
  persist,
  renames,
  useController,
]

export {
  asyncState,
  createField,
  ctxPrimitives,
  entities,
  errorContext,
  forms,
  identityMeta,
  mutateContext,
  mutationQueue,
  persist,
  reactMutation,
  removedApis,
  renames,
  rootApi,
  rootOptions,
  suspendOptions,
  useController,
}
