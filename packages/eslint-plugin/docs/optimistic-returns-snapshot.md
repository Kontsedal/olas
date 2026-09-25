# `olas/optimistic-returns-snapshot`

Reports a `setData` snapshot that nothing will settle. In `recommended`, as an error.

## Why

`setData` is the optimistic write. It returns a `Snapshot`, and the mutation runner rolls the patch back through it when a run fails, or commits it when the run succeeds. A snapshot that no code settles leaves `hasPendingMutations` true for good, and a failed run leaves its guess on screen. Two shapes lose the snapshot:

- **Inside `onMutate`, a snapshot that is not returned.** The runner settles only what `onMutate` returns.
- **Outside `onMutate`, a snapshot that is discarded.** A server push or a realtime fold written with `setData` leaves a live snapshot behind on every call. `write` is the canonical patch for that.

A snapshot the code keeps, returns or settles at once passes: `setData(…).finalize()` is the only canonical patch a `LocalCache` has. A function passed to `onMutate` by name counts as the hook. An optional call, `todos?.setData(…)`, is judged the same way as a plain one.

## Examples

```ts
// Reported: the snapshot is dropped, so the runner cannot roll it back
createMutation(ctx, def, {
  onMutate(vars) {
    todos.setData((prev) => [...prev, vars])
  },
})

// Reported: a canonical update written as an optimistic one
realtime.on((event) => {
  todos.setData((prev) => fold(prev, event))
})

// Fine
createMutation(ctx, def, {
  onMutate: (vars) => todos.setData((prev) => [...prev, vars]),
})
realtime.on((event) => todos.write((prev) => fold(prev, event)))
```
