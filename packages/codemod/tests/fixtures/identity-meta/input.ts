import { createMutation, defineInfiniteQuery, defineMutation, defineQuery } from '@kontsedal/olas-core'
import type { Ctx } from '@kontsedal/olas-core'

declare const ctx: Ctx
declare const spec: any
declare const base: { key: () => unknown[] }
declare const other: { onSuccess(): void }
const queryId = 'from-variable'
const crossTab = true

export const user = defineQuery({
  queryId: 'user',
  key: (id: string) => [id],
  fetcher: async (_ctx, id: string) => id,
  crossTab: true,
})
export const anonymous = defineQuery({ key: () => [], fetcher: async () => 1 })
export const legacyMode = defineQuery({
  key: () => [],
  fetcher: async () => 1,
  crossTab: 'data',
})
export const shorthand = defineQuery({ queryId, key: () => [], fetcher: async () => 1, crossTab })
export const hasMeta = defineQuery({ id: 'm', key: () => [], fetcher: async () => 1, crossTab: true, meta: { a: 1 } })
export const feed = defineInfiniteQuery({ queryId: 'feed', crossTab: false })
export const spread = defineQuery({ ...base, fetcher: async () => 1 })
export const unseen = defineQuery(spec)

export const save = defineMutation({
  mutationId: 'save',
  mutate: async (v: string) => v,
})
export const named = defineMutation({ mutationId: 'named', name: 'Named', mutate: async () => 1 })
export const off = defineMutation({ mutationId: 'off', persist: false, mutate: async () => 1 })
export const on = defineMutation({ mutationId: 'on', persist: true, name: 'On', mutate: async () => 1 })
export const hooked = defineMutation({ mutationId: 'hooked', mutate: async () => 1, onSuccess: () => {} })
export const withMeta = defineMutation({ mutationId: 'wm', name: 'x', mutate: async () => 1, meta: {} })
export const unseenMutation = defineMutation(spec)
export const migrated = defineMutation({ id: 'done', mutate: async () => 1 })
export const noId = defineMutation({ mutate: async () => 1 })

createMutation(ctx, { ...save, onSuccess: () => {} })
createMutation(ctx, {
  ...save,
  onSuccess: () => {},
  onError: () => {},
})
createMutation(ctx, { ...save })
createMutation(ctx, { ...save, concurrency: 'serial' })
createMutation(ctx, { ...save, ...other })
createMutation(ctx, { name: 'inline', mutate: async () => 1 })
createMutation(ctx, { id: 'has-id', name: 'dropped', mutate: async () => 1 })
createMutation(ctx, { mutationId: 'm', name: 'x', persist: true, mutate: async () => 1 })
createMutation(ctx, { mutationId: 'only', mutate: async () => 1 })
createMutation(ctx, { ...other, mutate: async () => 1 })
createMutation(ctx, save)
createMutation(ctx, spec)
createMutation(ctx)
