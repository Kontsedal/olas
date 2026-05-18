# Olas

**A controller-tree architecture for browser apps.** All business logic lives in a tree of pure TypeScript controllers; the UI is a thin renderer that subscribes to them.

```
createRoot(rootController, { deps })
   ↓
ControllerInstance (root)
  ├── ctx       — primitive factory bound to this controller's lifetime
  ├── child     — sub-controllers (ctx.child)
  ├── state     — reactive (ctx.field / ctx.form / ctx.fieldArray)
  ├── async     — data (ctx.cache / ctx.use)
  ├── writes    — mutations (ctx.mutation)
  ├── events    — emitters (ctx.emitter / ctx.on)
  └── lifecycle — hooks (ctx.onDispose / onSuspend / onResume)
```

`SPEC.md` is the authoritative design. `.wiki/` is the agent-maintained codebase wiki — start at [`.wiki/index.md`](.wiki/index.md) for current architecture.

---

## Why

UIs grow because business logic and rendering are tangled together. Component-tree state is easy at first and hard at scale; global stores are scalable but blunt; "hooks at the top of a page" hides ownership. Olas pulls business logic *out* of the UI tree into a parallel controller tree that:

- **Owns its lifetime explicitly** — every primitive (field, query, mutation, child) is bound to a controller and disposed when the controller is.
- **Is framework-agnostic** — the React adapter is ~200 lines; Vue/Svelte adapters would be similar. The core never imports a UI library.
- **Tests like plain TypeScript** — no framework runtime, no mocked components. Tests pass deps in, call methods, assert signals.
- **Carries reactivity through `Signal<T>`** — wrapping `@preact/signals-core` behind our own types. No special "store" or "atom" concept; signals are just typed boxes.

See SPEC.md `§1–3` for the principles, `§22` for the phase plan and what's shipped.

---

## Quick example

```ts
// 1. Define controllers
import { defineController, createRoot, signal, defineQuery } from '@olas/core'

const userQuery = defineQuery({
  key: (id: string) => [id],
  fetcher: async (id, signal) => {
    const res = await fetch(`/api/users/${id}`, { signal })
    return res.json() as Promise<{ id: string; name: string }>
  },
})

const userProfile = defineController((ctx, props: { id: string }) => {
  const isEditing = signal(false)
  const user = ctx.use(userQuery, () => [props.id])

  return {
    isEditing,
    user,
    toggleEdit: () => isEditing.update((v) => !v),
  }
})

// 2. Construct the root once, near app entry
const root = createRoot(userProfile, {
  deps: { /* api clients, services, etc. */ },
  // props: handled by the wrapper in createRoot? No — root has no props.
})

// 3. Read from React (or any UI)
import { OlasProvider, useRoot, use, useQuery } from '@olas/react'

function UserCard() {
  const api = useRoot<typeof userProfile.__types.api>()
  const { data, isLoading } = useQuery(api.user)
  const editing = use(api.isEditing)
  // …
}
```

---

## Packages

| Package | Status | Purpose |
|---------|--------|---------|
| [`@olas/core`](packages/core) | Phases 0–12 ✓ | Signals, controllers, queries, mutations, forms, scopes, SSR, devtools bus |
| [`@olas/react`](packages/react) | Phase 10 ✓ | React adapter — `OlasProvider`, `useRoot`, `use`, `useQuery`, `useField`, `KeepAlive` |
| [`@olas/persist`](packages/persist) | Phase 11 ✓ | `usePersisted` + localStorage adapter |
| [`@olas/zod`](packages/zod) | Phase 9 ✓ | `zodValidator` + `formFromZod` |

Unimplemented: Phase 13 (devtools browser extension), Phase 14 (polish in flight).

---

## Install

```bash
pnpm add @olas/core @olas/react @preact/signals-core react
# optional
pnpm add @olas/persist @olas/zod zod
```

`@preact/signals-core` is a peer dep on `@olas/core` — the library does not bundle it.

---

## Commands

```bash
pnpm install                                       # link workspace + install
pnpm typecheck                                     # tsc --noEmit per package
pnpm lint                                          # biome check .
pnpm test                                          # vitest run (all packages)
pnpm build                                         # tsup per package → dist/{mjs,cjs,d.ts}

pnpm wiki:lint                                     # check .wiki/ for broken refs
```

CI = `install → typecheck → lint → test → build`. 205 tests, all green.

---

## Learn more

- [`SPEC.md`](SPEC.md) — the authoritative design (cite as §N.M). Start at §1.
- [`.wiki/index.md`](.wiki/index.md) — codebase wiki; per-module pages, decisions, pitfalls.
- [`.wiki/overview.md`](.wiki/overview.md) — one-page architecture.
- [`.wiki/decisions/`](.wiki/decisions) — *why* the codebase looks like it does.
- [`.wiki/pitfalls/`](.wiki/pitfalls) — bug patterns and surprising behaviors documented from real bugs.
- [`CLAUDE.md`](CLAUDE.md) — orientation for Claude Code working in this repo.
- [`WIKI_SPEC.md`](WIKI_SPEC.md) — the codebase-wiki pattern this repo uses.

---

## License

MIT.
