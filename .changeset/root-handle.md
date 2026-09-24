---
"@kontsedal/olas-core": major
"@kontsedal/olas-react": major
"@kontsedal/olas-devtools": major
---

**The root is a handle, and your api lives on `root.api`.**

```ts
const root = createRoot(app, { deps, queries: queryEngine() })
root.api.increment()  // was root.increment()
root.dispose()
```

Before 1.0, `createRoot` returned the controller's api with the root controls mixed in. That reserved eight names in every app's namespace: `dispose`, `suspend`, `resume`, `bindQuery`, `dehydrate`, `waitForIdle`, `applyDehydratedEntry` and `__debug`. An api using one of them threw at startup. It also meant any root control added later would break someone. Now the api and the controls never share a namespace:

- A controller may return anything, including a primitive, and members named `dispose` or `suspend`.
- `root.inject(scope)` is new. It resolves a scope as the root controller would.
- `root.hydrate(state)` replaces `root.applyDehydratedEntry(id, key, data, lastUpdatedAt)`. It takes a whole `DehydratedState`.
- `root.debug` replaces `root.__debug`. The devtools components take `root: Pick<Root, 'debug'>`.
- `createTestController` returns the same handle (`const { api } = createTestController(def, { deps })`). `props` may be omitted for a controller that takes none, and the helper accepts `plugins`, `scopes` and `hydrate`.
- In `@kontsedal/olas-react`, `useRoot()` and `createOlasContext().useRoot()` still return the api. `useController(root)` is removed: it was an identity function, and `root.api` says the same thing.
