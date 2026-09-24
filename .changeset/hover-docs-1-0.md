---
"@kontsedal/olas-core": patch
"@kontsedal/olas-cross-tab": patch
"@kontsedal/olas-devtools": patch
"@kontsedal/olas-mutation-queue": patch
"@kontsedal/olas-react": patch
"@kontsedal/olas-realtime": patch
"@kontsedal/olas-zod": patch
---

**Hover docs that described 0.8, or claimed what the code does not do, are corrected.** No behaviour changes.

- **zod:** `ExtraValidators` said an array-level rule in the schema, such as `z.array(...).min(3)`, is enforced on the parent. It is not, and a form with one tag reads as valid. The doc now says to restate such a rule as a root `.refine(...)` with no `path`, whose message lands in `form.topLevelErrors`. A test pins both halves.
- **cross-tab:** `meta.crossTab` said infinite queries do not sync. They do, with their page params. The `origins` doc now says an `entities.update(...)` patch stays in its tab unless `origins` names the entities plugin. The clone note no longer says a class instance throws at `postMessage`: it arrives as a plain object.
- **react:** the streaming examples rendered a `HydrationBoundary` on the server without a query engine. A server render runs no effects, so nothing disposes the boundary's root, and without an engine there is no cache to capture. They now build one root per request and render it through `OlasProvider`.
- **mutation-queue:** the serialization notes said functions and symbols throw at enqueue. JSON drops them silently. A `BigInt` or a cycle is what throws.
- **realtime:** a connection state with no reporter is `'unknown'`, not `'connected'`, and the composables are named `create*`.
- **core:** `AsyncState` lists its ten signals, including `isEnabled`. `DehydratedEntry.id` no longer mentions anonymous queries. The subscription docs name `createQuery`, not `ctx.use`. `createSelection` cites SPEC §16.5.
- **devtools:** the store's doc names `useValue`.
- **core:** `DebugEventMeta.seq` no longer links a type that is not exported. `Form.submitError` no longer says a validation failure leaves it as it was: every `submit(...)` clears it first.
