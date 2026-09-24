import { createRoot, defineController } from '@kontsedal/olas-core'

const app = defineController(() => ({ count: 1 }))
const root = createRoot(app, { deps: {} })
const maxIdle = 5_000

root.suspend({ maxIdle: 30_000 })
root.suspend({ maxIdle })
root.suspend()
root.suspend({})
root.resume()

const options = { maxIdle: 1 }
root.suspend(options)
const none = {}
root.suspend(none)

// Not a root: left alone.
declare const other: { suspend(o: { maxIdle: number }): void }
other.suspend({ maxIdle: 1 })
declare function suspend(o: object): void
suspend({ maxIdle: 1 })
