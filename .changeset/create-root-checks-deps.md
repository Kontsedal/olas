---
"@kontsedal/olas-core": major
---

**`createRoot` checks `deps` against `AmbientDeps`.**

`createRoot` inferred the type of `deps` from the object it was given, so `createRoot(app, { deps: {} })` compiled in an app whose `AmbientDeps` declares an `api`. The missing service showed up at runtime as `undefined`, and the docs advised `satisfies AmbientDeps` as a workaround. The type parameter is now `TDeps extends AmbientDeps`, so the compiler checks it:

```ts
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: ApiClient
  }
}

createRoot(app, { deps: {} })                     // error: `api` is missing
createRoot(app, { deps: { api } })                // ok
createRoot(app, { deps: { api, clock: Date.now } }) // ok: extra members are allowed
```

A root that passes less than the app declared no longer compiles. Pass the missing service, or make it optional in the augmentation. `createTestController` does not check, so a test still passes only the fakes its controller reads.
