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

export const plain = createRoot(app, { deps: {} })
export const withDefaults = createRoot(app, {
  deps: {},
  defaultQueryOptions: { staleTime: 1_000, refetchOnWindowFocus: false },
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
})
export const flagsOnly = createRoot(app, { deps: {}, refetchOnReconnect: false })
export const sharedDefaults = createRoot(app, {
  deps: {},
  defaultQueryOptions: shared,
  refetchOnWindowFocus: true,
})
export const justDefaults = createRoot(app, { deps: {}, defaultQueryOptions: shared })
export const routed = createRoot(app, { deps: {}, scopes: adapter.scopes })
export const routedWithPlugins = createRoot(app, {
  deps: {},
  plugins: [crossTabPlugin({ channelName: 'app' })],
  scopes: adapter.scopes,
})
export const routedPluginVariable = createRoot(app, {
  deps: {},
  plugins: pluginList,
  scopes: adapter.scopes,
})
export const routedSpread = createRoot(app, { deps: {}, scopes: [...adapter.scopes] })
export const otherScoped = createRoot(app, { deps: {}, scopes: otherScopes })
export const engineBare = createRoot(app, {
  deps: {},
  queries: queryEngine(),
  refetchOnWindowFocus: true,
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
  defaultQueryOptions: { staleTime: 5 },
})
export const t3 = createTestController(app, options)

export const e1 = queryEngine({ defaultQueryOptions: { staleTime: 1 } })
export const e2 = queryEngine({ defaults: {} })
export const e3 = queryEngine()

export function App() {
  return (
    <>
      <HydrationBoundary def={app} options={{ deps: {} }}>
        ready
      </HydrationBoundary>
      <HydrationBoundary def={app} options={options} />
      <HydrationBoundary def={app} options="unchecked" />
      <HydrationBoundary def={app} />
      <div data-options={{ deps: {} }} />
    </>
  )
}
