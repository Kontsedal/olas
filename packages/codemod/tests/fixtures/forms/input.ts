import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
import { use } from '@kontsedal/olas-react'

declare const ctx: Ctx
declare const save: (value: unknown) => Promise<void>
declare function track(fn: unknown): void

const profile = ctx.form({ name: ctx.field('') })
const tags = ctx.fieldArray(() => ctx.field(''))

export const current = profile.value.value
export const tagValues = tags.value.value
export const watched = use(profile.value)
export const unsubscribe = profile.value.subscribe(() => {})
export const optional = (maybe?: typeof profile) => maybe?.value.peek()
export const optionalSignal = (maybe?: typeof profile) => maybe?.value

// A field is its own signal already: left alone.
export const name = profile.fields.name.value

// Form-shaped, but its `value` is not a signal: left alone.
declare const lookalike: {
  value: number
  submit(): void
  resetWithInitial(): void
  markAllTouched(): void
}
export const plain = lookalike.value
declare const signalOf: ReadSignal<number>
export const read = signalOf.value

profile.resetWithInitial({ name: 'Ada' })

export async function submit() {
  await profile.submit(save)
  const result = await profile.submit(save)
  track(profile.submit)
  return result.ok
}
