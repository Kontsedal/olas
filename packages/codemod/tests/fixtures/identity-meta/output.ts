import { createMutation, defineInfiniteQuery, defineMutation, defineQuery } from '@kontsedal/olas-core'
import type { Ctx } from '@kontsedal/olas-core'

declare const ctx: Ctx
declare const spec: any
declare const base: { key: () => unknown[] }
declare const other: { onSuccess(): void }
const queryId = 'from-variable'
const crossTab = true

export const user = defineQuery({
  id: 'user',
  key: (id: string) => [id],
  fetcher: async (_ctx, id: string) => id,
  meta: { crossTab: true },
})
export const anonymous = defineQuery({ id: 'src/input.ts:17', key: () => [], fetcher: async () => 1 })
export const legacyMode = defineQuery({
  id: 'src/input.ts:18',
  key: () => [],
  fetcher: async () => 1,
  meta: { crossTab: true },
})
export const shorthand = defineQuery({ id: queryId, key: () => [], fetcher: async () => 1, meta: { crossTab: crossTab } })
export const hasMeta = defineQuery({ id: 'm', key: () => [], fetcher: async () => 1, meta: { a: 1, crossTab: true } })
export const feed = defineInfiniteQuery({ id: 'feed', meta: { crossTab: false } })
export const spread = defineQuery({ ...base, fetcher: async () => 1 })
export const unseen = defineQuery(spec)

export const save = defineMutation({
  id: 'save',
  mutate: async (v: string) => v,
  meta: { persist: true },
})
export const named = defineMutation({ id: 'named', meta: { persist: true }, mutate: async () => 1 })
export const off = defineMutation({ id: 'off', mutate: async () => 1 })
export const on = defineMutation({ id: 'on', meta: { persist: true }, mutate: async () => 1 })
export const hooked = defineMutation({ id: 'hooked', mutate: async () => 1, onSuccess: () => {}, meta: { persist: true } })
export const withMeta = defineMutation({ id: 'wm', mutate: async () => 1, meta: { persist: true } })
export const unseenMutation = defineMutation(spec)
export const migrated = defineMutation({ id: 'done', mutate: async () => 1 })
export const noId = defineMutation({ mutate: async () => 1 })

createMutation(ctx, save, { onSuccess: () => {} })
createMutation(ctx, save, {
  onSuccess: () => {},
  onError: () => {},
})
createMutation(ctx, save)
createMutation(ctx, { ...save, concurrency: 'serial' })
createMutation(ctx, { ...save, ...other })
createMutation(ctx, { id: 'inline', mutate: async () => 1 })
createMutation(ctx, { id: 'has-id', mutate: async () => 1 })
createMutation(ctx, { id: 'm', meta: { persist: true }, mutate: async () => 1 })
createMutation(ctx, { id: 'only', mutate: async () => 1 })
createMutation(ctx, { ...other, mutate: async () => 1 })
createMutation(ctx, save)
createMutation(ctx, spec)
createMutation(ctx)
