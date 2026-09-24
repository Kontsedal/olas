import { createRoot, defineController, MutationDisposedError } from '@kontsedal/olas-core'
import type { ErrorContext } from '@kontsedal/olas-core'

declare function log(...values: unknown[]): void

const app = defineController(() => ({}))
createRoot(app, {
  deps: {},
  onError: (err, context) => {
    log(context.key, context.kind)
    if (err instanceof MutationDisposedError) log(err.mutationId)
  },
})

export function describe({ key: queryKey, kind }: ErrorContext) {
  return [queryKey, kind]
}
export function describeKey({ key: key2 }: ErrorContext) {
  return key2
}

// Not an ErrorContext: left alone.
declare const unrelated: { queryKey: string; mutationName: string }
export const u = [unrelated.queryKey, unrelated.mutationName]
export const { queryKey: plain } = unrelated
export const [first] = [1]
