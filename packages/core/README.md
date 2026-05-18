# @olas/core

The core of Olas: signals, controllers, queries, mutations, forms, scopes, SSR, and the devtools event bus. UI-framework-agnostic — no React, Vue, or Svelte imports anywhere.

This package is the only place that touches `@preact/signals-core` (peer dep). Everything else is plain TypeScript.

## Install

```bash
pnpm add @olas/core @preact/signals-core
```

## 30-second example

```ts
import { defineController, createRoot, signal, defineQuery } from '@olas/core'

const greetingQuery = defineQuery({
  key: (name: string) => [name],
  fetcher: async (name) => `Hello, ${name}`,
})

const greeter = defineController((ctx, props: { name: string }) => {
  const greeting = ctx.use(greetingQuery, () => [props.name])
  const excited = signal(false)
  return { greeting, excited, shout: () => excited.set(true) }
})

// In a non-React project: drive it directly via signals.
const root = createRoot(/* …a no-props wrapper… */, { deps: {} })
root.greeting.firstValue().then(console.log) // → "Hello, world"
```

For UI integration, see [`@olas/react`](../react).

## What's in the box

| Concern | API |
|---------|-----|
| Reactive primitives | `signal`, `computed`, `effect`, `batch`, `untracked` |
| Time-based signals | `debounced`, `throttled` |
| Controllers | `defineController`, `createRoot`, `Ctx` |
| Async data | `ctx.cache`, `defineQuery`, `defineInfiniteQuery`, `ctx.use` |
| Mutations | `ctx.mutation` with `parallel` / `latest-wins` / `serial` modes |
| Forms | `ctx.field`, `ctx.form`, `ctx.fieldArray`, stdlib validators |
| Cross-tree data | `defineScope`, `ctx.provide`, `ctx.inject` |
| Events | `createEmitter`, `ctx.emitter`, `ctx.on` |
| SSR | `root.dehydrate()`, `createRoot(def, { hydrate })`, `root.waitForIdle()` |
| Devtools | `root.__debug.subscribe(handler)` (events documented in `DebugEvent`) |
| Errors | `RootOptions.onError`, `ErrorContext`, `isAbortError` |

## Sub-paths

- `@olas/core` — the main entry.
- `@olas/core/testing` — `createTestController`, `fakeField`, `fakeAsyncState`. Test-only helpers.

```ts
import { createTestController, fakeField, fakeAsyncState } from '@olas/core/testing'
```

## Status

Phases 0–12 of the [spec](../../SPEC.md) are implemented. Phase 13 (devtools browser extension) and Phase 14 (polish & docs) are in flight. `ctx.collection`, `ctx.session`, and `ctx.lazyChild` are unimplemented (spec §20.2).

## Further reading

- [`SPEC.md`](../../SPEC.md) — authoritative design.
- [`.wiki/modules/`](../../.wiki/modules/) — per-module pages (signals, controller, query, forms, …).
- [`.wiki/pitfalls/`](../../.wiki/pitfalls/) — known footguns.
