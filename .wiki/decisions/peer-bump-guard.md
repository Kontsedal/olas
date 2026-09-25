---
name: peer-bump-guard
description: Why `check:peer-bumps` exists — changesets 3 bumps a package whose peer range a release leaves behind by a patch, and a narrower peer range is a breaking change.
type: decision
covers:
  - scripts/check-peer-bumps.mjs
  - scripts/pin-peer-ranges.mjs
  - .changeset/config.json
  - .github/workflows/version.yml
  - .github/workflows/publish.yml
  - package.json
edges:
  - { type: related, target: toolchain.md }
  - { type: related, target: esm-only-build.md }
  - { type: documented-in, target: ../../CLAUDE.md }
last_verified: 2026-09-25
confidence: medium
---

# The peer-bump guard

## The problem

Every internal peer range has a ceiling at the next major: `>=1.0.0 <2.0.0`. A core major therefore leaves every satellite's range behind, and `changeset version` has to rewrite each one.

Changesets 2 released each such dependent as a major. Changesets 3 releases it as a **patch** (changesets PR #2090), and no config option restores the old bump. A dry run on two throwaway worktrees showed the difference. A changeset naming only `@kontsedal/olas-core: major` took core from 1.0.0 to 2.0.0:
- **Changesets 2.31** took `@kontsedal/olas-react` to 2.0.0.
- **Changesets 3.0.3** took it to 1.0.1, with its peer range rewritten to `>=2.0.0 <3.0.0`.

An app on core 1 that depends on `@kontsedal/olas-react@^1.0.0` would install 1.0.1, which requires core 2. Dropping a peer major is a breaking change, so the dependent needs a major.

## The decision

Take changesets 3 and changesets/action v2, and add a check: `scripts/check-peer-bumps.mjs`, run as `pnpm check:peer-bumps`.

It reads the pending `.changeset/*.md` files and computes each package's next version from the strongest bump that names it. Then it fails for every package that lacks a major changeset of its own while an internal peer's next version falls outside that package's peer range. The message names the package, the peer and the range. The fix is a changeset that names the package as major and says which peer it now requires.

- **CI runs it** after `check:peer-ranges`, so the pull request that adds a core major fails until the satellites' changesets exist.
- **`pnpm version-packages` runs it first**, so `version.yml` fails instead of opening a Version Packages PR with patch bumps.
- **`publish.yml` runs it** with the rest of the verify chain. After a version PR merges, no changesets are left, so it passes trivially there.

It reads the files and not `changeset status`, because `status` also fails on a package changed without a changeset, which a docs-only pull request is.

The check was run against three cases on the post-1.0 state. A core major alone fails for all eleven satellites. A core major with majors for every direct satellite still fails for mutation-queue, which peers on both core and persist. A core minor passes.

## What else changed with changesets 3

- **Changesets 3.0.3 keeps the ceiling** when it rewrites a range (`>=2.0.0 <3.0.0`). `scripts/pin-peer-ranges.mjs` still runs after `changeset version` as the backstop, and `check:peer-ranges` still catches a hand-edited range.
- **`changeset version` exits 1 with no changesets.** A bare local `pnpm version-packages` on a clean tree fails.
- **CHANGELOGs are no longer run through prettier.** Code blocks keep their authored style, and the blank lines inside an entry keep the list's two-space indent.
- **The workflows use the sub-actions.** `version.yml` runs `changesets/action/version`, which can only open or update the PR. `publish.yml` runs `changesets/action/publish`, which can only publish. Changesets/action v1 switched a publish run to version mode when changesets were pending; the publish sub-action cannot.
