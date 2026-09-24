import { createRoot, defineController, type Root } from '@kontsedal/olas-core'
import { createTestController } from '@kontsedal/olas-core/testing'

const app = defineController(() => ({
  count: 1,
  increment() {},
  feature: { items: [1] },
}))
const root = createRoot(app, { deps: {} })

root.api.increment()
export const items = root.api.feature.items
export const nested = [root.api.count, root.api.feature]
export const cast = (root as Root<{ count: number }>).api.count
export const conditional = (Math.random() > 0.5 ? root : root).api.count
root.dispose()
root.debug.subscribe(() => {})
root.applyDehydratedEntry('q', [], 1, 0)

const { count, increment } = root.api
const { dispose } = root
const { count: c2, dispose: d2 } = root
const { __debug } = root
const { feature } = (Math.random() > 0.5 ? root : root).api
export const copy = { ...root }
export const kept = [count, increment, dispose, c2, d2, __debug, feature]

const t = createTestController(app, { deps: {}, props: undefined })
t.api.increment()

export const maybe: Root<{ count: number }> | undefined = root
export const viaOptional = maybe?.api.count

// A member the root's type lacks is not api, so an earlier run's `.api` stays.
export const migrated = root.api

// Not a root: left alone.
const plain = { count: 1 }
export const n = plain.count
