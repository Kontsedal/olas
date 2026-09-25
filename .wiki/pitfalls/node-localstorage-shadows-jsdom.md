---
name: node-localstorage-shadows-jsdom
description: On Node 25 and later the global `localStorage` is Node's own Web Storage, undefined without `--localstorage-file`, and it hides jsdom's — so a jsdom test that touches localStorage silently skips storage.
type: pitfall
covers:
  - packages/persist/tests/coverage-local-storage.test.ts
  - packages/devtools/tests/coverage-launcher.test.tsx
edges:
  - { type: related, target: ../modules/persist.md }
last_verified: 2026-09-25
confidence: medium
---

# Node's `localStorage` hides jsdom's

## The trap

Node 25 ships a Web Storage global. Without `--localstorage-file`, `globalThis.localStorage` is `undefined`, and it is defined on the global before jsdom installs its own. Under `// @vitest-environment jsdom`, a test that reads `localStorage` therefore gets Node's `undefined`, not jsdom's `Storage`.

The code under test then takes its "no storage" path. `localStorageAdapter()` returns `null` for every read and no-ops every write, and the devtools launcher skips persistence. The test still passes, but it isn't testing storage.

## The fix in a test

Install jsdom's storage explicitly, as `packages/devtools/tests/coverage-launcher.test.tsx` and `packages/persist/tests/coverage-local-storage.test.ts` do:

```ts
const jsdomStorage = (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window.localStorage
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: jsdomStorage })
  localStorage.clear()
})
```

`vi.stubGlobal('localStorage', jsdomStorage)` works too.

## How to spot it

A storage test that passes on Node 22 and still passes on Node 26 with its assertions on stored values removed has stopped exercising storage. Assert on what storage holds, not only on the app's behavior.

Found by the 1.0 coverage pass (2026-09-25).
