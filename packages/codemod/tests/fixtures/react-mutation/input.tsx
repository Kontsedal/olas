import type { Mutation } from '@kontsedal/olas-core'
import { useMutation } from '@kontsedal/olas-react'

declare const save: Mutation<string, number>
declare function after(p: Promise<number>): void

export function Editor() {
  const m = useMutation(save)
  const { mutateAsync } = useMutation(save)
  const { mutateAsync: saveNow, mutate, isPending } = useMutation(save)
  const handler = m.mutate
  const forward = mutate

  async function submit() {
    await m.mutate('a')
    const n = await m.mutateAsync('b')
    m.mutate('c')
    void m.mutate('d')
    after(m.mutate('e'))
    m.mutate('f').then(() => {})
    await mutate('g')
    mutate('h')
    await mutateAsync('i')
    await saveNow('j')
    return n
  }
  const later = () => m.mutate('k')
  const alsoLater = () => mutate('l')
  return (
    <button onClick={() => m.mutate('m')} onBlur={() => mutate('n')} disabled={isPending}>
      {String([submit, later, alsoLater, handler, forward])}
    </button>
  )
}

// Destructured from something else, or not from a variable: left alone.
export function Other({ mutate }: { mutate(v: string): Promise<void> }) {
  const { a } = { a: 1 }
  const [b] = [2]
  for (const { isPending } of [] as ReturnType<typeof useMutation>[]) void isPending
  return mutate(String(a + b))
}

// A `mutate` member on something that is not a `useMutation` result: left alone.
declare const other: { mutate(v: string): Promise<void>; mutateAsync: number }
export const o = other.mutate('x')
