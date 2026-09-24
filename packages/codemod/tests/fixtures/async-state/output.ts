import type { Ctx, Query } from '@kontsedal/olas-core'

declare const ctx: Ctx
declare const userQuery: Query<[string], { name: string }>

const user = ctx.use(userQuery, () => ['me'])

export const first = user.firstValue()
export const waiter = user.firstValue

// Not an AsyncState: left alone.
declare const deferred: { promise(): Promise<void> }
export const other = deferred.promise()
