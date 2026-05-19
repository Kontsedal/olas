# @olas/zod

## 0.0.1-rc.1

### Patch Changes

- Fill npm package metadata.

  Every publishable package now has `repository` (linking npm → github source
  directory), `homepage` (deep-linking the per-package README), `bugs.url`
  (github issues), `author` (Bohdan Kontsedal), and a focused `keywords`
  list. Descriptions tightened to one sentence each. No code change — purely
  manifest metadata that surfaces on the npm package page.

- Updated dependencies
  - @kontsedal/olas-core@0.0.1-rc.1

## 0.0.1-rc.0

### Patch Changes

- Initial release candidate.

  First public publish to npm. All seven packages move from 0.0.0 → 0.0.1-rc.0
  in lockstep so cross-package version skew stays at zero through the RC line.

  What's in this RC, beyond the baseline architecture (controllers, signals,
  queries, mutations, forms, scopes, SSR):

  - `@olas/core`: `selection` composable (spec §17.5) — multi-select with
    shift-click range + meta-click toggle, Finder-style snapshot semantics so
    subsequent shift-clicks can shrink or grow the range.
  - `@olas/realtime`: `useRealtimePatcher` + `defineLiveStream` (spec §16.5).
  - `@olas/cross-tab`: `BroadcastChannel`-backed cache sync (spec §13.2).
  - `@olas/devtools`: in-app `DevtoolsPanel` + draggable floating launcher.
  - Production builds strip `__DEV__` guards (commit d39708a) so devtools
    emission and field-validation hooks drop out of prod bundles.

- Updated dependencies
  - @olas/core@0.0.1-rc.0
