---
"@kontsedal/olas-core": patch
"@kontsedal/olas-react": patch
"@kontsedal/olas-zod": patch
"@kontsedal/olas-persist": patch
"@kontsedal/olas-devtools": patch
"@kontsedal/olas-realtime": patch
"@kontsedal/olas-cross-tab": patch
---

Initial release candidate.

First public publish to npm. All seven packages move from 0.0.0 → 0.0.1-rc.0
in lockstep so cross-package version skew stays at zero through the RC line.

What's in this RC, beyond the baseline architecture (controllers, signals,
queries, mutations, forms, scopes, SSR):

- `@kontsedal/olas-core`: `selection` composable (spec §17.5) — multi-select with
  shift-click range + meta-click toggle, Finder-style snapshot semantics so
  subsequent shift-clicks can shrink or grow the range.
- `@kontsedal/olas-realtime`: `useRealtimePatcher` + `defineLiveStream` (spec §16.5).
- `@kontsedal/olas-cross-tab`: `BroadcastChannel`-backed cache sync (spec §13.2).
- `@kontsedal/olas-devtools`: in-app `DevtoolsPanel` + draggable floating launcher.
- Production builds strip `__DEV__` guards (commit d39708a) so devtools
  emission and field-validation hooks drop out of prod bundles.
