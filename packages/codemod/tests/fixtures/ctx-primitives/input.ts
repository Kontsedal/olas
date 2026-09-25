import { defineController, required, type Ctx } from '@kontsedal/olas-core'
import type { ControllerDef, Query } from '@kontsedal/olas-core'

declare const userQuery: Query<[string], string>
declare const child: ControllerDef<void, { ok: boolean }>

export const profile = defineController((ctx) => {
  const count = ctx.signal(0)
  const doubled = ctx.computed(() => count.value * 2)
  const email = ctx.field<string>('', [required()])
  const form = ctx.form({ email, other: ctx.field('') })
  const list = ctx.fieldArray(
    () => ctx.field(''),
  )
  const user = ctx.use(userQuery, () => ['me'])
  const save = ctx.mutation({
    mutate: async (v: string) => v,
  })
  const cache = ctx.cache(async () => 1)
  const empty = ctx.form()
  const [sub, close] = ctx.session(child, undefined)
  ctx.effect(() => {})
  return { count, doubled, email, form, list, user, save, cache, empty, sub, close }
})

// Any expression typed as a ctx counts, whatever its name.
export function helper(c: Ctx) {
  return c.field(0)
}

// A local `signal` hides the import, so this site is reported, not rewritten.
export const shadowed = defineController((ctx) => {
  const run = (signal: AbortSignal) => ctx.signal(signal.aborted)
  return { run }
})

// Not a ctx: left alone.
declare const store: { field(x: number): number; signal(): void }
store.field(1)
store.signal()
