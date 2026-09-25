---
name: root-handle-separate
description: Why createRoot returns a handle with the app api on `.api` instead of the api with root controls mixed in.
type: decision
covers:
  - packages/core/src/controller/root.ts
  - packages/core/src/controller/types.ts
  - packages/core/src/testing.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: related, target: ../flows/use-root.md }
last_verified: 2026-09-25
confidence: medium
---

# The root is a handle; the api lives on `root.api`

## The decision

`createRoot(def, options)` returns a `Root<Api>`:

```ts
type Root<Api> = {
  readonly api: Api
  bindQuery, inject, dispose, suspend, resume, dehydrate, hydrate, waitForIdle
  readonly debug: DebugBus
}
```

Before 1.0 it returned `Api & controls`. The factory's return value got the controls attached as non-enumerable, locked properties, and `createRoot` threw when the api already defined one of their names.

## Why

**The intersection reserved names in the user's namespace.** `dispose`, `suspend`, `resume`, `bindQuery`, `dehydrate`, `waitForIdle`, `applyDehydratedEntry` and `__debug` were all unavailable to any root controller. `suspend` and `resume` are ordinary words for a media player or a timer.

**It froze the root surface at 1.0.** Adding a control in 1.x would take a name some app already uses and break it at startup. `bindQuery` already did that once, in 0.9 (MIGRATING). A handle has no such cost: `root.inject` and `root.hydrate` land here, and the next control will too.

**Primitive apis needed a wrapper.** A factory returning `42` had nowhere to carry `dispose`. It got wrapped as `{ value: 42 }` with a dev warning, so the declared `Root<Api>` type lied in that branch. With a handle, `root.api` is `42`.

**Downstream types were working around it.** Two examples declared `type AppApi = Omit<AppRoot, 'dispose' | 'suspend' | … | '__debug'>`, and about 40 test sites cast roots to `Api & { dispose(): void }`. Both are now `AppRoot['api']` or the inferred type.

## What it cost

Every `root.x` became `root.api.x`: 1,238 sites across the repo's tests and examples. They were rewritten by `scripts/codemods/root-api.ts`, a ts-morph codemod that uses the type checker to tell a root from anything else. The same transform ships in the 1.0 codemod for users. In the React adapter nothing changed at the call site: `useRoot()` has always returned the api, and now it returns `root.api`.

The handle is `Object.freeze`d. That is the same fence the locked properties gave the old controls, now applied to the whole object.
