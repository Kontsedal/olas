---
name: errors
description: ErrorContext (kind, controllerPath, queryId and key, pluginName) and dispatchError, the one route every caught user-callback throw takes to the root's onError.
type: module
covers:
  - packages/core/src/errors.ts
  - packages/core/src/plugin/host.ts:173-175
  - packages/core/src/query/client.ts:1383-1410
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/errors.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/mutants-client.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/coverage-core-plugins.test.ts }
  - { type: related, target: ../decisions/plugin-host-v2.md }
last_verified: 2026-09-25
confidence: high
---

# `errors.ts`

`ErrorContext` (`errors.ts:18-30`) describes where an error came from. Spec §12, §20.9.

| Field | Set when |
|---|---|
| `kind` | Always: `'effect' \| 'cache' \| 'mutation' \| 'emitter' \| 'construction' \| 'plugin'` |
| `controllerPath` | Always. `[]` for the query client and for plugins |
| `queryId` and `key` | `kind: 'cache'`. `key` is the entry's key, the output of `spec.key(...)` |
| `pluginName` | `kind: 'plugin'` |
| `eventId` and `timestamp` | Always, stamped by `dispatchError` |
| `attempt` and `cause` | Declared for telemetry adapters. No core call site sets them |

`ErrorContextInput` (`errors.ts:40`) is the context without `eventId` and `timestamp`. It is internal and left the package index in 1.0; call sites pass it, and `dispatchError` stamps the rest.

## Where each kind comes from

- **`'effect'`**: an effect body or its cleanup, a lifecycle hook, a teardown throw during dispose or rollback, and a throwing field validator (`controller/instance.ts`, `forms/bind.ts:38`).
- **`'emitter'`**: a `ctx.emitter()` handler or a `ctx.on(...)` handler (`instance.ts:564-610`).
- **`'construction'`**: a `ctx.collection` item or a `ctx.lazyChild` that fails after the root is alive (spec §12.1).
- **`'mutation'`**: a throwing `onError`, `onSuccess` or `onSettled` hook, through `MutationImpl.safeCall` (`query/mutation.ts:665-674`). A failed `mutate` goes to the mutation's `error` signal instead.
- **`'cache'`**: the refetch an `invalidate` started failed. `invalidateEntry` reports it with `queryId` and `key` and resolves the caller's promise (`query/client.ts:1394-1405`). Pinned by `mutants-client.test.ts`, "a failing refetch an invalidate started reports a cache error naming the entry".
- **`'plugin'`**: a plugin hook threw, or a plugin called `host.reportError`. `PluginSet.report` adds `pluginName` and `controllerPath: []` (`plugin/host.ts:173-175`). Delivery isolates each hook, so the next plugin still runs. Pinned by `plugin-host.test.ts` and `coverage-core-plugins.test.ts`.

## `dispatchError`

`dispatchError(handler, err, context)` (`errors.ts:65-88`) calls the root's `onError` if one is set, else `console.error`. If the handler itself throws, the dispatcher logs both errors and swallows the throw. The rule from spec §12 is that `onError` never breaks the program. Pinned by `errors.test.ts`.

Every primitive that runs a user callback routes its throws through here, so reporting is the same everywhere. That covers `effect` bodies, `on` handlers, the lifecycle hooks, mutation hooks and plugin hooks.
