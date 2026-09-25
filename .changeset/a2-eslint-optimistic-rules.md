---
"@kontsedal/olas-eslint-plugin": patch
---

**`cancel-before-optimistic` and `optimistic-returns-snapshot` match the code they document.**

- `cancel-before-optimistic` accepts `cancelAll()` as a cancel.
- It compares receivers without the wrappers that leave the value alone: `!`, `as`, `satisfies`, parentheses and `?.`. So `todos.cancel()` covers `todos!.setData(fn)` and `(todos as Todos).setData(fn)`.
- It checks an `onMutate` hook passed by name, as in `onMutate: applyOptimistic`, like one written in place.
- `optimistic-returns-snapshot` reports a dropped `todos?.setData(fn)`. The optional call's `ChainExpression` used to count as a use of the result.
