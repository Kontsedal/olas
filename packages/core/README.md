# @kontsedal/olas-core

The core of Olas — UI-framework-agnostic. Signals, controllers, queries, mutations, forms, scopes, SSR, and the devtools event bus. No React / Vue / Svelte imports anywhere.

This package is the only place that touches `@preact/signals-core` (peer dep). Everything else is plain TypeScript.

## Install

```bash
pnpm add @kontsedal/olas-core @preact/signals-core
```

## What's in the box

| Concern | API |
|---|---|
| Reactive primitives | `signal`, `computed`, `effect`, `batch`, `untracked` |
| Time-based signals | `debounced`, `throttled` |
| Controllers | `defineController`, `createRoot`, `Ctx` |
| Async data — shared | `defineQuery`, `defineInfiniteQuery`, `ctx.use` |
| Async data — local | `ctx.cache` |
| Mutations | `ctx.mutation` with `parallel` / `latest-wins` / `serial` modes |
| Forms | `ctx.field`, `ctx.form`, `ctx.fieldArray`, stdlib validators |
| Cross-tree data | `defineScope`, `ctx.provide`, `ctx.inject` |
| Events | `createEmitter`, `ctx.emitter`, `ctx.on` |
| Lifecycle | `ctx.effect`, `ctx.child`, `ctx.attach`, `ctx.onDispose`, `ctx.onSuspend`, `ctx.onResume` |
| SSR | `root.dehydrate()`, `createRoot(def, { hydrate })`, `root.waitForIdle()` |
| Devtools | `root.__debug.subscribe(handler)` (events documented in `DebugEvent`) |
| Errors | `RootOptions.onError`, `ErrorContext`, `isAbortError` |

Full reference with signatures and examples: [`../../API.md`](../../API.md).

## 30-second example

```ts
import { createRoot, defineController, signal } from '@kontsedal/olas-core'

const counter = defineController(() => {
  const count = signal(0)
  return { count, increment: () => count.update((n) => n + 1) }
})

const root = createRoot(counter, { deps: {} })
root.increment()
console.log(root.count.value)    // 1
root.dispose()
```

## Sub-paths

- `@kontsedal/olas-core` — the main entry.
- `@kontsedal/olas-core/testing` — `createTestController`, `fakeField`, `fakeAsyncState`. Test-only helpers; the sub-path makes "you imported testing utilities into production code" loud and grep-able.

```ts
import { createTestController, fakeField, fakeAsyncState } from '@kontsedal/olas-core/testing'
```

## Further reading

- [`../../API.md`](../../API.md) — every export, signature, example.
- [`../../README.md`](../../README.md) — guided tour.
- [`../../SPEC.md`](../../SPEC.md) — authoritative design.
- [`../../.wiki/modules/`](../../.wiki/modules/) — per-module pages (signals, controller, query, forms, …).
- [`../../.wiki/pitfalls/`](../../.wiki/pitfalls/) — known footguns.
