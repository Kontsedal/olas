---
name: raf-unbound-illegal-invocation
description: "Assigning native requestAnimationFrame UNBOUND to a field then calling it as a method throws 'Illegal invocation' in real browsers — invisible to jsdom, so tests miss it."
type: pitfall
covers:
  - packages/devtools/src/store.ts:233-247
edges:
  - { type: tested-by, target: ../../packages/devtools/tests/store.test.ts }
  - { type: related, target: ../modules/devtools-panel.md }
last_verified: 2026-07-28
confidence: high
---

# Don't assign native `requestAnimationFrame` unbound and call it as a method

`DevtoolsStore`'s `coalesce: 'raf'` path stores a scheduler on `this.schedule` and
later calls `this.schedule(fn)`. The obvious form is a **bug**:

```ts
// WRONG — this.schedule(fn) invokes native rAF with `this === store`
this.schedule = requestAnimationFrame
```

Native `requestAnimationFrame` / `cancelAnimationFrame` (and most DOM methods) require
`this` to be the global (`window`). Called as `this.schedule(fn)` — i.e. as a method of
the store — `this` is the store, and a real browser throws
**`TypeError: Illegal invocation`**. Fix by wrapping so it's called bare (global `this`):

```ts
this.schedule = (fn) => requestAnimationFrame(fn)
this.cancelSchedule = (h) => cancelAnimationFrame(h)
```

## Why it hid for so long

- **jsdom's `requestAnimationFrame` is a plain JS function** that ignores `this`, so it
  never throws — every RTL/`vitest` test (jsdom or the `sync` coalesce path) passed.
- The throw happened inside `scheduleFlush`, which runs inside a `__debug` handler, and
  `DevtoolsEmitter.emit` wraps handlers in an **empty** `try/catch` — so it was swallowed
  with no console error.
- The failure was *partial*, which masked it: `tree$` / `cacheState$` are set
  **synchronously** (in `handle`'s switch / on `attach`) so the Tree and Inspector tabs
  worked; only the **coalesced** signals (`cache$` / `mutations$` / `fields$` / `events$`)
  route through the flush and stayed empty. First event's `scheduleFlush` threw and left
  `flushHandle` stuck at the `-1` sentinel, so no flush was ever scheduled again.

Net symptom in a real browser: the devtools **Tree + Inspector populate, but Timeline /
Cache / Mutations / Fields are permanently empty** — with no error in the console.

## Lesson

Only a real browser catches this (found by running the kanban example end-to-end, not by
the test suite). When a wrapper stores a **native DOM method** for later call, wrap it in
an arrow (or `.bind(globalThis)`) — never assign it unbound. The regression test in
`store.test.ts` installs a strict `requestAnimationFrame` that throws on a non-global
`this`, reproducing the browser behavior under vitest.
