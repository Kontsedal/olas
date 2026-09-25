---
"@kontsedal/olas-react": major
---

**`HydrationBoundary`'s `options.deps` is checked against `AmbientDeps`,** as `createRoot`'s now are. `options` is typed `RootOptions<AmbientDeps>`, so in an app whose `AmbientDeps` names a service, `<HydrationBoundary options={{ deps: {} }}>` no longer compiles. Before, the prop took any object, and the missing service showed up at runtime.
