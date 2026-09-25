# `olas/cancel-before-optimistic`

Reports an optimistic `setData` in `onMutate` with no `cancel` on the same query before it. In `recommended`, as a warning; in `strict`, as an error.

## Why

The optimistic recipe (SPEC §6.4) is `cancel()` first, then `setData()`. A fetch already in flight resolves after the patch and overwrites it with the server's older state. "Nothing invalidates this query" is not a reason to skip the cancel. An entry also fetches when a subscriber acquires it while stale, and after `resume()`.

The rule compares the receiver as written: `todos.cancel()` covers `todos.setData(…)`, and `this.q.cancel()` covers `this.q.setData(…)`. `todos.cancelAll()` counts as a cancel too. The comparison ignores what leaves the value alone: a non-null `!`, an `as` or `satisfies` cast, parentheses and `?.`. So `todos.cancel()` covers `todos!.setData(…)` and `(todos as Todos).setData(…)`.

A function passed to `onMutate` by name, as in `onMutate: applyOptimistic`, is checked like one written in place.

## Examples

```ts
// Reported
createMutation(ctx, def, {
  onMutate: (vars) => todos.setData((prev) => [...prev, vars]),
})

// Fine
createMutation(ctx, def, {
  onMutate(vars) {
    todos.cancel()
    return todos.setData((prev) => [...prev, vars])
  },
})
```
