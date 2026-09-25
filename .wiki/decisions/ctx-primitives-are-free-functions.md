---
name: ctx-primitives-are-free-functions
description: Why createField/createQuery/createMutation take ctx as an argument instead of hanging off it, and why createRoot takes an explicit query engine.
type: decision
covers:
  - packages/core/src/controller/internals.ts
  - packages/core/src/forms/bind.ts
  - packages/core/src/query/bind.ts
  - packages/core/src/query/engine.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/tree-shaking.test.ts }
  - { type: related, target: ../entities/ctx.md }
  - { type: related, target: ../entities/query-client.md }
  - { type: related, target: per-root-query-client.md }
last_verified: 2026-09-25
confidence: medium
---

# ctx primitives are free functions

## The decision

Two changes, shipped together as one pre-1.0 major.

**The lifetime-owned primitives take `ctx` as their first argument.** `ctx.field(x)` became `createField(ctx, x)`, and likewise `createForm`, `createFieldArray`, `createCache`, `createQuery` (was `ctx.use`), `createMutation` and `bindQuery`.

**The query engine is explicit.** `createRoot(def, { deps, queries: queryEngine() })`. A root built without it has no cache: `createQuery`, `createMutation` and `bindQuery` throw a message naming the fix.

`ctx` keeps everything that binds to the controller's *tree and lifetime*: `emitter`, `child`, `attach`, `collection`, `lazyChild`, `effect`, `on`, `provide`, `inject`, `debug` and the lifecycle hooks. This change first kept `session`, `signal` and `computed` on it too. 1.0 removed all three: `ctx.attach` covers `session`, and `signal` and `computed` are imported like the rest.

## What it bought

Measured with `esbuild --bundle --minify --define:__DEV__=false`, gzipped, `@preact/signals-core` external, against `packages/core/src/index.ts`. **These are the source-structure ceiling, not what a consumer gets** — see the note below:

| Imported | Before | After |
|---|---|---|
| `signal`, `computed`, `effect`, `batch` | — | 0.3 KB |
| `createRoot`, `defineController` | **20.1 KB** | **4.8 KB** |
| \+ `createField`, `createForm` | 20.1 KB | 9.2 KB |
| \+ `queryEngine`, `createQuery` | 20.1 KB | 14.4 KB |
| everything | 21.8 KB | 22.6 KB |

A consumer who imports everything pays 0.8 KB more, for the engine indirection and the internals plumbing. That trade is the point: the cost moved onto the people who use the features.

**What consumers got at first: 19.9 KB → 8.2 KB, not 4.8.** Bundling the published `dist/` rather than `src/`, the query engine is excluded as designed but the forms subsystem is not. `tsdown` flattens the package into one shared chunk, so exclusion inside it depends on statement-level dead-code elimination — and `FormImpl`/`FieldArrayImpl` declare their brand markers as computed class-field keys (`[FORM_BRAND] = true`), which esbuild refuses to drop. A signals-only dist bundle still contains `olas.form`, verified by grep.

So the structural work was done and half the payoff was stuck in the build. 1.0's W5 closed it by assigning the brands in the constructor (`esm-only-build.md`). A controllers-only bundle from the published `dist` is now 5.9 KB gzipped against 0.8's 19.9 KB, measured the same way, and `pnpm smoke:dist` fails a build that retains forms or the engine again.

## Why the old shape could not be fixed in place

`Ctx` was one object literal with every method wired eagerly, built in `controller/instance.ts`. That module value-imported `createField`, `createForm`, `createFieldArray`, `createLocalCache`, `createMutation`, `createUse` and `createInfiniteUse`. `createRoot` reaches `ControllerInstance`, so every one of those subsystems was statically reachable from the only entry point anyone uses. Nothing a bundler does can remove code an object literal might call.

The same argument defeats the obvious fix for the query engine. Constructing the `QueryClient` lazily "on first use" does not help if the first-use site is `ctx.use`, because `ctx.use` lives in `instance.ts` and `instance.ts` is always reachable. The `new QueryClient(...)` expression has to leave `createRoot`'s module graph entirely, which is why `query/engine.ts` exists and is the only module that imports `QueryClient` by value.

"Entirely" is load-bearing and was not true at first. Both `instance.ts` and `root.ts` need to throw the "you forgot the engine" error, and that helper originally lived in `engine.ts` — so `createRoot` still held a value edge into the module that constructs the client, and the exclusion rested on a bundler's export-level dead-code elimination rather than on the graph. The helper now lives in `query/missing-engine.ts`, which imports nothing. `tests/tree-shaking.test.ts` pins that neither `instance.ts` nor `root.ts` reaches `query/engine.ts`.

## Why the engine was adopted eagerly

Plugin host v2 has since moved plugin startup out of the engine: `createRoot` sets each plugin up per root, engine or not (`plugin/host.ts`, `flows/plugin-lifecycle.md`). The constraint below shaped this change and no longer binds it.

At the time, `QueryClient`'s constructor ran plugin `init` (`query/client.ts`). Deferring construction would defer every plugin's startup side effects, and one of them cannot tolerate that: `mutationQueuePlugin` replays mutations persisted by a **previous session** at `init`. That is a startup obligation, not a response to anything the current session does, and the "any app with the plugin uses a mutation somewhere" argument fails because that code can be route-gated or code-split. A user's offline write would sit in storage until something happened to touch a query — possibly never.

So `createRoot` adopts the engine eagerly, before the factory runs, and plugin `init` fires at exactly the moment it always did. The bundle win comes from *where the constructor lives*, not from *when it runs*.

`crossTabPlugin` and `entitiesPlugin` would both have tolerated deferral. Only mutation-queue forced the design, and it was enough.

## The internals escape hatch

A free function needs what a method had: the disposal list, the controller path, the root's error handler and devtools bus. `controller/internals.ts` exposes them behind `Symbol.for('olas.ctx.internals')`, read through `ctxInternals(ctx, operation)`.

`Symbol.for` rather than a module-local symbol, for the reason in [`brand-markers-not-classes.md`](brand-markers-not-classes.md): two copies of the package in one dependency graph must agree. The accessor throws a named error when the symbol is absent, because the realistic failure is a hand-rolled test double standing in for a real `Ctx`, and `undefined is not an object` does not say that.

This is not public API, and the barrel does not export it — a typed public export would get bound to whatever "can change in a patch release" said next to it. `Symbol.for('olas.ctx.internals')` still reaches the key for anyone who needs it and accepts the risk knowingly, which is what a registered symbol is for.

## Naming

`create*`, following Solid's `createSignal`/`createMemo`/`createResource`.

Bare names were rejected: `const form = form(ctx, schema)` and `const field = field(ctx, '')` are the natural way to write those lines, and both are temporal-dead-zone errors. A `use*` convention was rejected because `useQuery`, `useField` and `useMutation` already exist in `@kontsedal/olas-react` with different signatures, and one ecosystem should not spell one name two ways.

`createQuery` sits next to the existing module-level `defineQuery` and the two are easy to confuse. `define*` builds a module-scope value with no controller; `create*` binds a thing to a controller's lifetime. That distinction is worth stating in the docs rather than solving with a longer name.

## What SPEC said before

SPEC recorded rejecting a `ctx` split into `CtxQuery`, `CtxForm` and `CtxLifecycle`. **That rejection stands and is not what happened here.** It targeted splitting `ctx` into three *parameters*, on the grounds that most helpers mix concerns and three parameters are worse than one. `ctx` is still one parameter. What changed is that primitives which never needed to be methods stopped being methods — which SPEC §3.3 already endorsed for every composable outside core (`usePersisted(ctx, …)` and `useRealtimePatcher(ctx, …)`, since renamed `createPersisted` and `createRealtimePatcher`). Core now follows its own rule.

## What would reopen this

Evidence that the `ctx.` autocomplete surface was load-bearing for discovery in a way the docs cannot replace. That is a real cost of the change and the one thing measurement cannot settle.
