import { createCache, createMutation, defineMutation } from '@kontsedal/olas-core'
import type { Ctx } from '@kontsedal/olas-core'

declare const ctx: Ctx
declare function saveUser(v: string, signal: AbortSignal): Promise<string>
declare function saveOne(v: string): Promise<string>
declare const load: (signal: AbortSignal) => Promise<number>
declare const noArgs: () => Promise<number>

export const a = defineMutation({ mutationId: 'a', mutate: async (v: string, signal) => v })
export const b = defineMutation({ mutationId: 'b', mutate: async (v: string, s: AbortSignal) => v })
export const c = defineMutation({
  mutationId: 'c',
  async mutate(v: string, signal) {
    return v
  },
})
export const d = defineMutation({ mutationId: 'd', mutate: async (v: string, { signal }) => v })
export const e = defineMutation({ mutationId: 'e', mutate: async (v: string) => v })
export const f = defineMutation({ mutationId: 'f', mutate: saveUser })
export const g = defineMutation({ mutationId: 'g', mutate: saveOne })
export const h = createMutation(ctx, {
  mutate: function (v: string, signal: AbortSignal) {
    return Promise.resolve(v)
  },
})
export const i = createMutation(ctx, { mutate: async (...args: unknown[]) => args })
const mutate = saveUser
export const j = createMutation(ctx, { mutate })
export const k = createMutation(ctx, { onSuccess() {} })
export const l = createCache(ctx, (signal) => Promise.resolve(1))
export const m = createCache(ctx, signal => Promise.resolve(1))
export const n = createCache(ctx, async signal => 1)
export const o = createCache(ctx, load)
export const p = createCache(ctx, async () => 1)
export const q = createCache(ctx, noArgs)
export const r = createMutation(ctx, a)
export const s = defineMutation(a)
export const t = createCache(ctx)
