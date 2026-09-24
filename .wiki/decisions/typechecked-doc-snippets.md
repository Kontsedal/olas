---
name: typechecked-doc-snippets
description: Why every TypeScript block in the user-facing docs compiles in CI against the package sources, how the checker builds its program, and its three annotations.
type: decision
covers:
  - scripts/check-doc-snippets.ts
  - .github/workflows/ci.yml
edges:
  - { type: related, target: prose-rules.md }
  - { type: related, target: esm-only-build.md }
last_verified: 2026-09-25
confidence: medium
---

# The docs' code blocks are typechecked

## The decision

`pnpm check:doc-snippets` (`scripts/check-doc-snippets.ts`) compiles every ` ```ts `, ` ```tsx ` and ` ```typescript ` block in the user-facing docs, and CI runs it after lint. The docs it reads:
- the root `README.md`, `API.md`, `RECIPES.md`, `PLUGINS.md` and `MIGRATING.md`;
- every `packages/*/README.md` and `examples/*/README.md`.

A block that does not compile fails the build, as a broken test would.

`SPEC.md` is not in the list. Its blocks are contract listings, and many are type sketches with no bodies. The docs a reader copies from are the ones checked.

## Why

The 1.0 review found docs whose examples would throw if copied. The first run of the checker, before the W6 docs pass, found 913 errors in 172 blocks across 19 files. Most were fragments with undeclared names, but the rest were real drift:
- 0.8 names that no longer exist: `usePersisted`, `formFromZod`, react `use`, `useLiveStream`, `useRealtimePatcher`, `adapter.scopes`, `mutationQueuePlugin({ adapter })`;
- the pre-handle root, `root.increment()` for `root.api.increment()`;
- the pre-v2 plugin shapes (`update`, `signal` members);
- `queryId` for `id`;
- React 18's global `JSX` namespace, which React 19 removed.

Review did not catch these, and each rename made the next one likelier. A compiler catches all of them, every time.

## How the program is built

- **One module per block.** Each block is written to `.doc-snippets/<pid>/<doc>/`, with `export {}` appended so its names cannot clash with another block's. The directory is per process, so two runs at once do not delete each other's files. A run deletes it at exit unless given `--keep`.
- **One program per doc.** A doc reads as one app. Its `AmbientDeps` or `Register` augmentation types every block in that doc and merges with no other doc's. In one shared program, two docs typing `deps.api` differently conflicted, which pushed the docs away from the `ctx.deps` idiom. A shared compiler host caches parsed files, so the package sources are parsed once. Diagnostics are requested for the snippet files only, and the full run takes about 13 s.
- **Olas imports resolve to source.** `paths` maps each published package name to its `src/index.ts`, and `@kontsedal/olas-core/testing` to `src/testing.ts`, as the vitest aliases do. No build is needed.
- **Third-party imports resolve through the workspace.** The `*` fallback lists each package's `node_modules/@types/*` and `node_modules/*`, then the root's. React, Vue, Svelte, Zod, Preact and vitest resolve that way.
- **What is declared ambient.** A generated `_ambient.d.ts` declares:
  - `import.meta.env`;
  - `*.vue` and `*.svelte` modules;
  - the two routers the workspace does not install (`@tanstack/react-router`, `react-router-dom`), as `any` modules. Only the Olas side of a router example is checked.
- **Errors map back** to `file.md:line`, with the prelude offset removed.
- **What is left alone.** The checker does not ask for errors inside a package source; those are the package typecheck's job. TS2307 on a relative specifier (`./App`) is the reader's own file, and the checker drops that too.

## The three annotations

Each annotation is invisible when the Markdown renders.

| Annotation | Where | What it does |
|---|---|---|
| `<!-- snippet-prelude … -->` | the lines right before a block | Code compiled with the block and not shown, such as `declare const userQuery: …`. It carries context the prose already gave the reader. It never hides a wrong API. |
| `file=name.ts` | the fence's info string | Names the block's module, so a later block in the same doc imports it as `./name`. The README's `counter.ts` and `main.tsx` pair works this way. |
| `nocheck` | the fence's info string | Skips the block. Only for type and signature listings, deliberate pseudo-code, and 0.8 "before" code in MIGRATING. A listing it skips is checked by hand. |

## Finding: an augmentation alone does not load a module

A block that only augments a package's `Register` interface:

```ts nocheck
declare module '@kontsedal/olas-svelte' {
  interface Register { root: typeof root }
}
```

failed with TS2664, "Invalid module name in augmentation", although `paths` resolved the name. TypeScript resolves an augmentation's module name. Only an import adds the resolved file to the program, though: `processImportedModules` in `program.ts` adds files for the import indexes and skips the augmentation ones. In an app, some other file imports the package, so the augmentation works. In a program made of isolated snippets nothing did. The checker now passes every package entry as a root file (`scripts/check-doc-snippets.ts:181-187`, used at `:211`).

## What it does not do

- It does not check that a signature listing matches the source, because listings are `nocheck`. `pnpm check:public-types` covers the declared surface's exports.
- It does not run anything. A block that compiles can still be wrong at runtime.
- It does not cover `SPEC.md`, `.cursorrules` or the wiki.
