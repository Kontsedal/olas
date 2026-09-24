import { createRoot, defineController, type Root } from '@kontsedal/olas-core'
import { createTestController } from '@kontsedal/olas-core/testing'

const app = defineController(() => ({
  count: 1,
  increment() {},
  feature: { items: [1] },
}))
const root = createRoot(app, { deps: {} })

root.increment()
export const items = root.feature.items
export const nested = [root.count, root.feature]
export const cast = (root as Root<{ count: number }>).count
export const conditional = (Math.random() > 0.5 ? root : root).count
root.dispose()
root.__debug.subscribe(() => {})
root.applyDehydratedEntry('q', [], 1, 0)

const { count, increment } = root
const { dispose } = root
const { count: c2, dispose: d2 } = root
const { __debug } = root
const { feature } = Math.random() > 0.5 ? root : root
export const copy = { ...root }
export const kept = [count, increment, dispose, c2, d2, __debug, feature]

const t = createTestController(app, { deps: {}, props: undefined })
t.increment()

export const maybe: Root<{ count: number }> | undefined = root
export const viaOptional = maybe?.count

// A member the root's type lacks is not api, so an earlier run's `.api` stays.
export const migrated = root.api

// Not a root: left alone.
const plain = { count: 1 }
export const n = plain.count
