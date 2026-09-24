import { createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import { createTestController } from '@kontsedal/olas-core/testing'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { HydrationBoundary } from '@kontsedal/olas-react'
import { createRouterAdapter } from '@kontsedal/olas-router'

const app = defineController(() => ({}))
const adapter = createRouterAdapter()
declare const shared: { staleTime: number }
declare const options: any
declare const pluginList: any[]
declare const otherScopes: any

export const plain = createRoot(app, { deps: {}, queries: queryEngine() })
export const withDefaults = createRoot(app, {
  deps: {},
  queries: queryEngine({ defaults: { refetchOnReconnect: true, staleTime: 1_000, refetchOnWindowFocus: false } }),
})
export const flagsOnly = createRoot(app, { deps: {}, queries: queryEngine({ defaults: { refetchOnReconnect: false } }) })
export const sharedDefaults = createRoot(app, {
  deps: {},
  queries: queryEngine({ defaults: { refetchOnWindowFocus: true, ...shared } }),
})
export const justDefaults = createRoot(app, { deps: {}, queries: queryEngine({ defaults: shared }) })
export const routed = createRoot(app, { deps: {}, plugins: [adapter.plugin], queries: queryEngine() })
export const routedWithPlugins = createRoot(app, {
  deps: {},
  plugins: [crossTabPlugin({ channelName: 'app' }), adapter.plugin],
  queries: queryEngine(),
})
export const routedPluginVariable = createRoot(app, {
  deps: {},
  plugins: pluginList,
  scopes: adapter.scopes,
  queries: queryEngine(),
})
export const routedSpread = createRoot(app, { deps: {}, scopes: [...adapter.scopes], queries: queryEngine() })
export const otherScoped = createRoot(app, { deps: {}, scopes: otherScopes, queries: queryEngine() })
export const engineBare = createRoot(app, {
  deps: {},
  queries: queryEngine({ defaults: { refetchOnWindowFocus: true } }),
})
export const engineConfigured = createRoot(app, {
  deps: {},
  queries: queryEngine({}),
  refetchOnWindowFocus: true,
})
export const engineOnly = createRoot(app, { deps: {}, queries: queryEngine() })
export const fromVariable = createRoot(app, options)

export const t1 = createTestController(app, { deps: {}, props: undefined })
export const t2 = createTestController(app, {
  deps: {},
  props: undefined,
  queries: queryEngine({ defaults: { staleTime: 5 } }),
})
export const t3 = createTestController(app, options)

export const e1 = queryEngine({ defaults: { staleTime: 1 } })
export const e2 = queryEngine({ defaults: {} })
export const e3 = queryEngine()

export function App() {
  return (
    <>
      <HydrationBoundary def={app} options={{ deps: {}, queries: queryEngine() }}>
        ready
      </HydrationBoundary>
      <HydrationBoundary def={app} options={options} />
      <HydrationBoundary def={app} options="unchecked" />
      <HydrationBoundary def={app} />
      <div data-options={{ deps: {} }} />
    </>
  )
}
