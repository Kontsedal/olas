---
name: duration-naming
description: The one naming rule for durations across the suite — milliseconds everywhere, `*Time` for core's lifetime policies, `*Ms` for every other knob.
type: decision
covers:
  - packages/core/src/controller/types.ts
  - packages/core/src/query/types.ts
  - packages/persist/src/index.ts
  - packages/mutation-queue/src/plugin.ts
  - packages/realtime/src/index.ts
edges:
  - { type: related, target: ../modules/query.md }
last_verified: 2026-09-25
confidence: medium
---

# Duration names

## The rule

1. **Every duration is in milliseconds.** No option takes seconds.
2. **Core's lifetime policies end in `Time`:** `staleTime`, `gcTime`, and `suspend({ maxIdleTime })`. They say how long something stays fresh, cached or alive. The names match TanStack Query, which most readers already know.
3. **Every other duration ends in `Ms`:** `throttleMs` (persist), `flushMs` (realtime), and `backoffMs`, `maxBackoffMs` and `ttlMs` (mutation-queue). These tune a mechanism rather than state a policy, and the suffix names the unit.
4. **`retryDelay` and `refetchInterval` keep their names.** Both also accept a function (`(attempt) => ms`, `(data) => ms`), so neither name can carry a unit suffix honestly. They match TanStack Query too.

## What changed for 1.0

`root.suspend({ maxIdle })` became `suspend({ maxIdleTime })`. It was the one duration with no unit or policy suffix. The survey behind the rule found nothing else out of line (`grep` over every package's `src` for `Time|Ms|Delay|Interval|Idle|Age|Ttl` option names).
