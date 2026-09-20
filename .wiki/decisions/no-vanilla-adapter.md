---
name: no-vanilla-adapter
description: Why olas ships no vanilla DOM adapter — the package was specced, built, measured and dropped, and SPEC §16 was amended to stop promising one.
type: decision
covers:
  - SPEC.md:1571-1600
edges:
  - { type: related, target: ../modules/react.md }
  - { type: related, target: ../modules/signals.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-09-20
confidence: high
---

# No vanilla DOM adapter

## The decision

Olas ships no vanilla DOM adapter. `@kontsedal/olas-react` is the only UI adapter, and a
consumer who wants a smaller runtime uses it through `preact/compat` rather than a second
package.

SPEC §16 listed "vanilla" beside React, Vue and Svelte from the first draft. That line was
a promise nobody had costed. It is now removed.

## What was actually built

A complete `@kontsedal/olas-dom` on 2026-09-20: 763 code lines, 82 tests, a lit-html
bridge on a `/html` sub-path, a cross-adapter parity test, a README, a wiki page and a CI
line-budget script. It passed typecheck, lint, 985 tests, build, publint and attw. Two
adversarial reviews ran against it, the second finding six real bugs that were fixed and
pinned.

It was deleted before commit. The work was not wasted — it produced the measurements that
settle the question, and three of them are now facts rather than opinions.

## The three measurements that killed it

**1. The bundle is 5.9 KB gzipped, not small.** The binder alone measured 17.2 KB raw and
5.9 KB gzipped (5.1 KB brotli), production build with `__DEV__` stripped. The whole point
of a vanilla adapter is to be smaller than a framework. Preact is in the same range, and
gives a component model for the money.

**2. The size argument cannot apply to an olas consumer at all.** This is the decisive
one, and it generalises past preact. `@kontsedal/olas-core` is substantially larger than
any of these renderers. Anyone shipping olas has already spent the bundle budget, so the
marginal cost of a real framework is noise. "Avoid a framework to save bytes" is never a
live concern for this library's users.

**3. Fine-grained updates are not a differentiator either.** `@preact/signals` binds a
signal straight to a text node with no diff. Olas core is built on
`@preact/signals-core`, so that path is unusually natural. The binder's per-binding update
story is matched by a library the project already depends on.

## The use cases did not survive either

The remaining case for a binder was "bind DOM you did not render". Three candidates were
offered and two collapsed on inspection.

- **Embeddable widgets** — you inject a container and render into it. A framework does
  that. You never needed to bind to the host page's own nodes.
- **Custom elements** — a custom element renders its own shadow DOM. Same answer.
- **Progressive enhancement over server HTML from a non-JS backend** — real, and not this
  library's audience. That developer reaches for Stimulus or Alpine, not for a controller
  tree with query caching, mutation queues and SSR dehydration. SPEC's own "Who this is
  for" says so.

## `@kontsedal/olas-react` already covers preact

Checked against the source, not assumed. The adapter imports exactly `createContext`,
`useContext`, `useCallback`, `useMemo`, `useRef`, `useSyncExternalStore`, `useEffect` and
`useLayoutEffect`, plus three types. Every one is in `preact/compat`. It never imports
`react-dom` — `streaming.ts` mentions `renderToPipeableStream` only inside doc comments,
and its real exports are a bootstrap-script string and a `TransformStream`, both renderer
agnostic. The peer range is `react: >=18` with no `react-dom`.

So preact support is probably an aliasing exercise and a test matrix, not a package. Three
things need verifying before the claim is made: `useSyncExternalStore` in compat is a
shim, `useSuspenseQuery` throws a promise and preact's Suspense retry semantics differ,
and compat's `StrictMode` is a no-op so `HydrationBoundary`'s double-construct handling
never fires. `BACKLOG.md` carries the item.

## What would reopen this

A consumer who has olas controllers and cannot load a component framework at all. Given
measurement 2, that consumer would have to be unable to ship olas-core either, which makes
the case self-defeating. Reopen only with a concrete application, not an argument.

A narrower piece is worth keeping on the table and is tracked separately in `BACKLOG.md`:
a framework-agnostic `bindField(el, field, opts)`. The deleted `input.ts` was 156 lines, 20% of the
package. It covered caret preservation across a differing write, IME composition guarded
in both directions with a replay at `compositionend`, per-element-kind routing, and
`transform` parity with `useFieldInput`. No framework supplies that, and `useFieldInput`
only covers the React props-spread shape.

## The process note worth keeping

The order was plan, review, build, review, measure. The measurement came last and reversed
the decision. Had the size been measured against preact during planning, the package would
not have been written.

The cost of finding out here was one uncommitted working tree. The cost of finding out
after `changeset publish` would have been a package on npm with a version number that can
never be reused. That asymmetry is why the teardown was cheap and correct.
