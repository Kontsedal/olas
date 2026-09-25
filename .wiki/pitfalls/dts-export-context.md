---
name: dts-export-context
description: A bundled .d.ts with no export list is an export context, so TypeScript exports every top-level declaration in it; rolldown-plugin-dts 0.28.2+ drops the list, which leaked entities' private brand symbols.
type: pitfall
covers:
  - packages/entities/scripts/dts-export-marker.ts
  - packages/entities/tsdown.config.ts
  - packages/entities/src/index.ts:13-17
edges:
  - { type: related, target: ../modules/entities.md }
  - { type: related, target: ../decisions/toolchain.md }
  - { type: related, target: ../decisions/docs-site.md }
  - { type: related, target: ../decisions/brand-markers-not-classes.md }
last_verified: 2026-09-25
confidence: medium
---

# A `.d.ts` without an export list exports everything

## The rule

In a declaration file, TypeScript treats every top-level declaration as exported unless the file has an export statement of its own: an `export { … }` list, an `export =`, or an empty `export {}`. The TypeScript binder calls such a file an export context. A `declare const X` that the source kept private is then importable from the package, as a type, with no runtime value behind it.

## How it bit

rolldown-plugin-dts 0.28.2, which tsdown 0.23 uses, keeps declarations "exported inline": `export declare function defineEntity …` instead of a trailing `export { defineEntity, … }` list. It also strips an empty `export {}` from the input. It adds one back only when a chunk has no module statement at all.

`packages/entities/src/index.ts` declares two private symbols, `BRAND` and `PHANTOM`, the keys of `EntityDef`'s brand and phantom type slot. Every export in the file is inline, so the bundled `index.d.ts` came out with no export list, and both symbols became part of the public types. `pnpm api:check` caught it: the entities report gained `export const BRAND: unique symbol` and `export const PHANTOM: unique symbol`.

The other packages were fine. Their chunks re-export types from other source modules, and the plugin writes those re-exports as an `export type { … }` list, which closes the export context.

## The fix

`packages/entities/scripts/dts-export-marker.ts` is a rolldown plugin in entities' `tsdown.config.ts`. In `generateBundle` it appends `export {}` to any `.d.ts` chunk without an export list. The line goes after the last declaration and before the `sourceMappingURL` comment, so the declaration map stays accurate.

## How to spot it

- An API report gains a symbol that the source does not export. `pnpm api:check` fails on it.
- A bundled `.d.ts` ends without an `export {` or `export type {` line, and holds a top-level `declare` with no `export` in front of it.

BACKLOG holds removing the plugin once rolldown-plugin-dts keeps the marker itself.
