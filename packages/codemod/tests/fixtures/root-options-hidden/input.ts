import { createRoot, defineController } from '@kontsedal/olas-core'

// A local `queryEngine` that is not core's: the engine is left to a human.
const queryEngine = () => 'mine'

const app = defineController(() => ({}))
export const root = createRoot(app, { deps: {} })
export const mine = queryEngine()
