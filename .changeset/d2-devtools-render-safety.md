---
"@kontsedal/olas-devtools": patch
---

**A devtools error no longer unmounts the host app, and object key members render as JSON.**

Two data shapes threw during render, and with no error boundary React unmounted the whole app. A null-prototype object in a query key, such as `query-string`'s `parse()` output, threw in `formatPath` and in the Cache filter. A `ctx.debug` computed that throws, such as `computed(() => items.value[0].name)` on an empty list, threw in the Tree. Its subscription also rethrew into the app's own write that made the computed throw.

- `formatPath` renders an object member of a key as compact JSON, capped at 60 characters. `['users', { page: 1 }]` read `users › [object Object]` before. A cycle reads `[Circular]`.
- `formatPayload` marks a cycle instead of falling back to `String()`, and returns `[unserializable]` when nothing can read the value.
- A `ctx.debug` variable that throws shows `threw` and the error in its row, and updates when it stops throwing.
- `<DevtoolsPanel>` shows a render error in place of the panel, with a Retry button. `<DevtoolsLauncher>` renders nothing when it fails outside the panel.
