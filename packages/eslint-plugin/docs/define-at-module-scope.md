# `olas/define-at-module-scope`

Reports `defineQuery`, `defineInfiniteQuery`, `defineMutation` or `defineScope` called inside a function. In `recommended`, as an error.

## Why

These definitions are identities, and the engine keys on them:
- a `defineQuery` inside a function mints a new query on every call. Two controllers that meant to share a cache entry each get their own, and their ids collide in the root;
- a `defineScope` inside a function makes a scope no other controller can `inject`;
- a `defineMutation` inside a function registers its id again on every call.

`defineController` and `definePlugin` are not checked. A controller def built inside a root-composition function, and a plugin built by a factory that takes options, are both the documented patterns, and neither is looked up by identity.

## Examples

```ts
// Reported
function loadUser() {
  const user = defineQuery({ id: 'user', key: () => [], fetcher })
  return user
}

// Fine
export const user = defineQuery({ id: 'user', key: () => [], fetcher })
```
