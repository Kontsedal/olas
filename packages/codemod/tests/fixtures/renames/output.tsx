import {
  type Ctx,
  type QueryDefaults,
  type ReadSignal,
  createSelection,
  type QuerySubscriptionOptions,
} from '@kontsedal/olas-core'
import * as olas from '@kontsedal/olas-core'
import { createPersisted } from '@kontsedal/olas-persist'
import { SuspendOnUnmount, SuspendOnUnmount as Existing, useValue } from '@kontsedal/olas-react'
import {
  createLiveStream,
  createConnectionState as connection,
  createRealtimePatcher,
} from '@kontsedal/olas-realtime'
import { type ZodFormOptions, createZodForm } from '@kontsedal/olas-zod'
import * as zod from '@kontsedal/olas-zod'

export { useValue as read } from '@kontsedal/olas-react'
export { createSelection as select } from '@kontsedal/olas-core'
export { other } from './elsewhere'

declare const ctx: Ctx
declare const count: ReadSignal<number>
declare const schema: object
declare const opts: ZodFormOptions<object>
declare const plainOptions: { extraValidators: object }

export const value = useValue(count)
export const handlers = { use: useValue }
export const sel = createSelection()
export const nsSel = olas.createSelection()
export type D = QueryDefaults
export type U = QuerySubscriptionOptions<[]>
export type NsD = olas.QueryDefaults
export const form = createZodForm(ctx, schema, { initial: { a: 1 } })
export const fromVariable = createZodForm(ctx, schema, opts)
export const noOptions = createZodForm(ctx, schema)
export const viaNamespace = zod.createZodForm(ctx, schema, { initial: {} })
export const noInitials = createZodForm(ctx, schema, { extraValidators: {} })
export const plain = createZodForm(ctx, schema, plainOptions)
export const reference = createZodForm
createPersisted(ctx, 'k', count)
createRealtimePatcher(ctx, 'ch', {})
export const stream = createLiveStream(ctx, 'ch')
export const conn = connection(ctx)

// A local binding that shadows the import, a member of some other object,
// and a local export: left alone.
export function shadow(use: (x: number) => number) {
  return use(1)
}
declare const obj: { use: number; selection: number }
export const members = obj.use + obj.selection
const local = 1
export { local }

export function View() {
  return (
    <SuspendOnUnmount controller={null}>
      <Existing controller={null} />
    </SuspendOnUnmount>
  )
}
