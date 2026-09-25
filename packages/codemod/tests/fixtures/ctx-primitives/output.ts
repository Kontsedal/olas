import { defineController, required, type Ctx, computed, createCache, createField, createFieldArray, createForm, createMutation, createQuery, signal } from '@kontsedal/olas-core'
import type { ControllerDef, Query } from '@kontsedal/olas-core'

declare const userQuery: Query<[string], string>
declare const child: ControllerDef<void, { ok: boolean }>

export const profile = defineController((ctx) => {
  const count = signal(0)
  const doubled = computed(() => count.value * 2)
  const email = createField<string>(ctx, '', [required()])
  const form = createForm(ctx, { email, other: createField(ctx, '') })
  const list = createFieldArray(
    ctx,
    () => createField(ctx, ''),
  )
  const user = createQuery(ctx, userQuery, () => ['me'])
  const save = createMutation(ctx, {
    mutate: async (v: string) => v,
  })
  const cache = createCache(ctx, async () => 1)
  const empty = createForm(ctx)
  const [sub, close] = ctx.session(child, undefined)
  ctx.effect(() => {})
  return { count, doubled, email, form, list, user, save, cache, empty, sub, close }
})

// Any expression typed as a ctx counts, whatever its name.
export function helper(c: Ctx) {
  return createField(c, 0)
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
