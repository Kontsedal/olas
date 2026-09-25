---
"@kontsedal/olas-vue": patch
---

**A server render leaves no subscription behind, and `useField(field).value` reads a write inside a `batch`.**

Vue never stops a component's effect scope on the server, so every ref a hook made during `renderToString` stayed subscribed after the request. During a server render, the refs now read their signals and subscribe to nothing. The adapter detects the render through Vue's `ssrContextKey`, which the server renderer provides.

`useField(field).value` was a Vue `computed`, which cached the field's value until a `batch` ended. Inside a `batch`, after `field.set('b')`, it still read the old value. It is now a ref that reads the field on every access, like the other refs, and still writes through `field.set` for `v-model`. Its type is `Ref<T>` instead of `WritableComputedRef<T>`.
