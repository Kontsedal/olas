# `olas/no-async-controller-factory`

Reports an `async` function passed to `defineController`. In `recommended`, as an error.

## Why

`createRoot` and `ctx.child` use the factory's return value as the controller's api at once. An `async` factory returns a promise, so the api is a promise. Every `ctx.*` call after the first `await` also runs after construction has finished, so the controller's lifetime bookkeeping is wrong.

Load data with a query and let the controller expose the subscription. An `async` function the factory defines, such as an action, is fine.

## Examples

```ts
// Reported
const profile = defineController(async (ctx) => {
  const user = await ctx.deps.api.getUser()
  return { user }
})

// Fine
const profile = defineController((ctx) => ({
  user: createQuery(ctx, userQuery),
  save: async () => {},
}))
```
