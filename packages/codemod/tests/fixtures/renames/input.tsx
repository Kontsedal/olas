import {
  type Ctx,
  type DefaultQueryOptions,
  type ReadSignal,
  selection,
  type UseOptions,
} from '@kontsedal/olas-core'
import * as olas from '@kontsedal/olas-core'
import { usePersisted } from '@kontsedal/olas-persist'
import { KeepAlive, SuspendOnUnmount as Existing, use } from '@kontsedal/olas-react'
import {
  useLiveStream,
  useRealtimeConnection as connection,
  useRealtimePatcher,
} from '@kontsedal/olas-realtime'
import { type FormFromZodOptions, formFromZod } from '@kontsedal/olas-zod'
import * as zod from '@kontsedal/olas-zod'

export { use as read } from '@kontsedal/olas-react'
export { selection as select } from '@kontsedal/olas-core'
export { other } from './elsewhere'

declare const ctx: Ctx
declare const count: ReadSignal<number>
declare const schema: object
declare const opts: FormFromZodOptions<object>
declare const plainOptions: { extraValidators: object }

export const value = use(count)
export const handlers = { use }
export const sel = selection()
export const nsSel = olas.selection()
export type D = DefaultQueryOptions
export type U = UseOptions<[]>
export type NsD = olas.DefaultQueryOptions
export const form = formFromZod(ctx, schema, { initials: { a: 1 } })
export const fromVariable = formFromZod(ctx, schema, opts)
export const noOptions = formFromZod(ctx, schema)
export const viaNamespace = zod.formFromZod(ctx, schema, { initials: {} })
export const noInitials = formFromZod(ctx, schema, { extraValidators: {} })
export const plain = formFromZod(ctx, schema, plainOptions)
export const reference = formFromZod
usePersisted(ctx, 'k', count)
useRealtimePatcher(ctx, 'ch', {})
export const stream = useLiveStream(ctx, 'ch')
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
    <KeepAlive controller={null}>
      <Existing controller={null} />
    </KeepAlive>
  )
}
