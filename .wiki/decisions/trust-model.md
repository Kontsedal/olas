---
name: trust-model
description: The 1.0 security pass — what Olas trusts, what it checks, the findings by severity, and where each fix and its test live. SPEC §22 is the contract; this page is the record.
type: decision
covers:
  - packages/core/src/html.ts
  - packages/react/src/streaming.ts
  - packages/mutation-queue/src/plugin.ts
  - packages/persist/src/query-cache.ts
  - packages/persist/src/index.ts
  - packages/cross-tab/src/plugin.ts
  - packages/entities/src/index.ts
  - packages/core/src/forms/form.ts
  - packages/core/src/query/client.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/react/tests/streaming-security.test.tsx }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/security.test.ts }
  - { type: related, target: ../pitfalls/stream-chunks-split-tags.md }
  - { type: related, target: ../pitfalls/proto-key-assignment.md }
last_verified: 2026-09-24
confidence: medium
---

# Trust model and the 1.0 security pass

## The model

SPEC §22 states it. In short:
- **Trusted as authored:** a `DehydratedState` from the app's own server, and every script in the page. Same-origin code can already do anything Olas could guard against.
- **Untrusted:** query and mutation data. Olas never evaluates it, never lets its keys change a prototype, and escapes it for every HTML context it writes into.
- **Possibly corrupt:** storage and `BroadcastChannel` messages, which a user, an old build or a one-off script may have written. Olas validates structure, types, ranges and depth, and drops or reports what does not fit.

## How the pass was done

One read-only review agent covered four areas:
- the streaming SSR scripts;
- every deserialization path: persist, the mutation queue, cross-tab, core hydration and the streaming intake;
- prototype pollution in merge, structural-share and deep-set code;
- the trust boundaries.

It reproduced each finding against the built `dist` with probe scripts outside the repo. `Object.prototype` was never polluted. The findings were fixed with a regression test each, and each test was confirmed to fail on the old code.

## Findings and fixes

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| H1 | high | `createStreamingTransform` wrote a batch mid-tag, so query data could become attributes (XSS) | `HtmlBoundary` tokenizer; a batch goes out only between elements | `streaming-security.test.tsx` |
| H2 | high | the mutation queue replayed any registered mutation storage named, and a key/contents mismatch replayed forever | replay only `meta.persist` definitions (new `host.mutations.get`); key must match contents; migrated entries rewritten; full validation | `mutation-queue/tests/security.test.ts` |
| M1 | medium | the streamed payload was an object literal, so an own `__proto__` key became the prototype on the client | `serializeForScript`: `JSON.parse("…")` with everything risky escaped | `streaming-security.test.tsx` |
| M2 | medium | no CSP nonce for the streamed scripts | `createStreamingHydrator({ nonce })` | `streaming-security.test.tsx` |
| M3 | medium | reader-ssr inlined state with `JSON.stringify` and a string `replace` (XSS, `$'` expansion) | `renderPage` with function replacements and `serializeForScript`; `HydrationBoundary` docs | `reader-ssr/tests/page.test.ts` |
| L1 | low | a stored cache entry dated in the future stayed fresh forever | reject `lastUpdatedAt` later than now plus five minutes | `query-cache-security.test.ts` |
| L2 | low | `Form.set` followed the prototype chain; `createPersisted` left `ready` false when its source threw | own keys only; report `'deserialize'` and settle `ready` | core `regressions.test.ts`, `persisted-security.test.ts` |
| L3 | low | a deeply nested key or a `null` entry made `createRoot({ hydrate })` throw | per-entry guard in `QueryClient`; `entries` must be an array | core `regressions.test.ts` |
| L4 | low | an async query-cache restore failure skipped `onError` | `.then(ok).catch(onError)` | `query-cache-security.test.ts` |
| L5 | low | the entities deep merge let a `__proto__` key replace an entity's prototype | own-key reads, `defineProperty` writes | `merge-security.test.ts` |
| L6 | low | a cross-tab message could throw out of the listener, or silence a peer with `msgId: Number.MAX_VALUE` | try/catch to `onWarn`; safe-integer `msgId`; `validate` option | `cross-tab/tests/security.test.ts` |
| L7 | low | a crafted URL hash crashed an app mounting the devtools panel with `urlHashKey` | validate the parsed hash | devtools tests |
| L8 | low | a page element with id `__OLAS_HYDRATION__` clobbered the streaming intake | the bootstrap and each batch check the global's shape | `streaming-security.test.tsx` |

## Reviewed and fine

- `<` was already escaped across each streamed batch, so `</script>` and `<!--` in data could not end the script. The mid-tag placement was the real hole.
- `structuralShare` already handled `__proto__`, through `defineOwn` and `Object.hasOwn`.
- `JSON.parse` and structured clone both keep `__proto__` as an own data property, and nothing in persist, the queue or devtools copied parsed keys onto a fresh `{}`.
- The entities store and its indexes are `Map`s, and `setAtPath` writes with a computed key and spread.
- Cross-tab writes reach only bound entries of opted-in queries, and the receiving tab stamps its own `Date.now()`, so a peer cannot forge freshness.
- There is no `eval`, `new Function` or `innerHTML` in any package source.

## What stays the consumer's

Olas does not check that restored data matches a query's type. `buster`, versioned channel names, `createPersisted`'s `version` and `migrate`, and cross-tab's `validate` are the tools for that.
