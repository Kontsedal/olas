---
name: codemod
description: "@kontsedal/olas-codemod — the 0.8 → 1.0 migration CLI on ts-morph: seventeen ordered transforms, the position-edit engine, how an import is traced to an Olas export, and the TODO list for what needs a human."
type: module
covers:
  - packages/codemod/src/index.ts
  - packages/codemod/src/cli.ts
  - packages/codemod/src/main.ts
  - packages/codemod/src/run.ts
  - packages/codemod/src/edits.ts
  - packages/codemod/src/types.ts
  - packages/codemod/src/util/ast.ts
  - packages/codemod/src/util/imports.ts
  - packages/codemod/src/util/olas.ts
  - packages/codemod/src/util/shape.ts
  - packages/codemod/src/transforms/index.ts
  - packages/codemod/src/transforms/forms.ts
  - packages/codemod/src/transforms/async-state.ts
  - packages/codemod/src/transforms/react-mutation.ts
  - packages/codemod/src/transforms/suspend-options.ts
  - packages/codemod/src/transforms/error-context.ts
  - packages/codemod/src/transforms/entities.ts
  - packages/codemod/src/transforms/mutation-queue.ts
  - packages/codemod/src/transforms/removed-apis.ts
  - packages/codemod/src/transforms/root-api.ts
  - packages/codemod/src/transforms/ctx-primitives.ts
  - packages/codemod/src/transforms/create-field.ts
  - packages/codemod/src/transforms/identity-meta.ts
  - packages/codemod/src/transforms/mutate-context.ts
  - packages/codemod/src/transforms/root-options.ts
  - packages/codemod/src/transforms/persist.ts
  - packages/codemod/src/transforms/renames.ts
  - packages/codemod/src/transforms/use-controller.ts
  - packages/codemod/tsdown.config.ts
  - packages/codemod/biome.json
edges:
  - { type: tested-by, target: ../../packages/codemod/tests/cli.test.ts }
  - { type: tested-by, target: ../../packages/codemod/tests/helpers.test.ts }
  - { type: tested-by, target: ../../packages/codemod/tests/transforms/root-api.test.ts }
  - { type: documented-in, target: ../../packages/codemod/README.md }
  - { type: related, target: ../decisions/root-handle-separate.md }
  - { type: related, target: ../decisions/required-id-and-meta.md }
  - { type: related, target: ../decisions/ctx-primitives-are-free-functions.md }
  - { type: related, target: ../decisions/forms-are-read-signals.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
last_verified: 2026-09-24
confidence: medium
---

# `@kontsedal/olas-codemod`

`npx @kontsedal/olas-codemod 1.0` migrates an app from the published 0.8 API. It loads the project with ts-morph, runs seventeen transforms in order, saves the changed files, and prints a TODO list. It grew out of the one-off scripts in `scripts/codemods/`, which rewrote this repo during the 1.0 work. The package README carries the user-facing table of what each transform rewrites.

The migration starts at 0.8 because npm has no 0.9: the release plan skipped it. So `ctx.field(...)` → `createField(ctx, ...)` and the explicit `queries: queryEngine()` are in scope, next to the 1.0 renames.

## The pipeline and its order

`transforms/index.ts` lists the transforms in the order they must run. One constraint sets the order. A type-driven transform needs the 0.8 types, and a rewrite to a 1.0 name destroys them. After `ctx.form(...)` becomes `createForm(ctx, ...)`, the 0.8 declarations have no `createForm`, the form's type is gone, and `forms` could no longer find `form.value.value`.

- **Type-driven first:** `forms`, `async-state`, `react-mutation`, `suspend-options`, `error-context`, `entities`, `mutation-queue`, `removed-apis`. Their rewrites keep the types of the code around them.
- **`root-api` last among them**, because the `root.api.x` it writes has no 0.8 type either.
- **The syntactic ones after:** `ctx-primitives`, `create-field`, `identity-meta`, `mutate-context`, `root-options`, `persist`, `renames`. They match callees and import bindings, not types, and later ones read what earlier ones wrote. `create-field` expects `createField(ctx, …)`, which `ctx-primitives` produces.
- **`use-controller` at the very end**, so the `.api` it writes is not taken for an api member by `root-api`.

The type checks live in `util/shape.ts`. Each asks for a few members only that 0.8 type combines: a root has `__debug`, `waitForIdle` and `applyDehydratedEntry`, and a form has `submit`, `resetWithInitial` and `markAllTouched`. So the checks work wherever the declarations come from, and they find nothing against the 1.0 types. `main.ts` warns when `node_modules/@kontsedal/olas-core` is 1.x, walking up from the project root as Node does.

`root-api` rewrites `root.x` only when the root's type declares `x` (`transforms/root-api.ts`, `hasMember`). That is the "type proves `x` is api" rule, and it makes a second run skip the `root.api` a first run wrote.

## The edit engine

`edits.ts` holds `FileChanges`, one per file per transform. A transform collects plain position edits, then `runPerFile` applies every file's edits after the whole pass has read. So the type checker's program stays valid for the pass, with one rebuild per transform instead of one per file.

- **Back to front.** Edits apply in descending position, so a site nested inside another keeps both edits. That is the lesson of `scripts/codemods/root-api.ts`.
- **Collection order at one position.** Two insertions at the same offset keep the order they were collected in.
- **An overlap is a TODO.** An edit whose range crosses one already applied is skipped and reported, not guessed at.
- **Line endings are kept.** ts-morph's `replaceWithText` writes every line break as the project's `newLineKind`, LF by default, which would turn a CRLF file into a whole-file diff. `replaceKeepingNewlines` sets that setting to the file's own ending for the one write.

No transform calls ts-morph's language-service `rename()`. The W4b script found that `rename()` on an un-aliased import specifier renames the exported symbol for every importer at once, into `node_modules` declarations too. `renames.ts` instead rewrites the specifier and every identifier in the file bound to it, compared by symbol (`util/ast.ts`, `localReferences`). A shorthand property keeps its key: `{ use }` → `{ use: useValue }`.

## Tracing a binding to an Olas export

`util/olas.ts` answers "which Olas export does this identifier name". `refOf` covers an imported identifier such as `use`, a namespace member such as `olas.use`, and a qualified type name such as `olas.UseOptions`.

1. An import specifier whose module is `@kontsedal/olas-<pkg>` names `<pkg>`'s export. A sub-path such as `/testing` maps to its package.
2. Otherwise the alias chain is followed to its declaration. A declaration inside `declare module '@kontsedal/olas-<pkg>'`, or in a file under `node_modules/@kontsedal/olas-<pkg>/`, names that package. This is how a local barrel that re-exports Olas is traced.

`importsOf` keeps only a specifier whose imported name equals the export's name. A barrel that re-exports `useRoot as use` is left alone, since renaming its importers would not match it.

`util/imports.ts` adds the named imports a rewrite needs. It appends to an existing value import of the module, or adds a declaration after the last import, after a `'use client'` prologue, or at the top. It copies the file's quote style and semicolons. `visibleBinding` refuses a name another binding holds at the site: a `signal` parameter in scope blocks `ctx.signal(…)` → `signal(…)`, and the site becomes a TODO.

## Behaviour it keeps on purpose

Three rewrites keep 0.8 behaviour that 1.0 changed. The README lists them for users.
- Every `createRoot` gains `queries: queryEngine()`, since every 0.8 root had a client.
- A `defineMutation` without `persist` gains `meta: { persist: true }`, since 0.8 persisted a defined mutation by default.
- `clearPersisted()` without a prefix becomes `{ all: true }`, with a TODO.

A `defineMutation` that has an `id` and no `mutationId` is 1.0 already, and `identity-meta` leaves it alone. Without that check, a second run would add a second `persist`.

## Tests

- `tests/fixtures/_types.d.ts` declares minimal 0.8 stubs of every package as ambient modules, so the fixtures resolve no built `dist`. Its shapes carry the members `util/shape.ts` checks for.
- Each transform has `tests/transforms/<name>.test.ts`, which runs `fixtures/<name>/input.ts(x)` in an in-memory project and compares the result to `output.ts(x)`. It asserts the site count and each TODO's line and reason, and then runs the transform on its own output and expects no change. `forms` is exempt from that last check: under the 0.8 types, the `form.value` it writes still reads as a signal.
- `tests/cli.test.ts` copies `fixtures/project/input` to a temp directory and runs `main` on it. The project spans five files, including a barrel. The test compares every file to `fixtures/project/expected`, and covers `--dry`, paths, no tsconfig, the 1.x warning and the usage errors. It also imports `src/cli.ts` under a stubbed `process.argv`.
- `tests/helpers.test.ts` covers the edit engine, the import adder, `refOf` through a real `node_modules` path, and the runner's TODO dedupe and sort.

**Checked on the 0.8 example apps.** On 2026-09-24 the built CLI ran over `examples/` from the `@kontsedal/olas-core@0.8.0` tag. A tsconfig mapped each Olas import to the 0.8 package sources, so the real 0.8 types resolved. The run scanned 97 files and changed 208 sites in 47 of them. It reported 11 TODOs: nine reads of the entity store and two placeholder ids. The migrated controllers of stock-ticker, virtualized-table and reader-ssr typecheck against the 1.0 sources. Where a file has a hand-migrated 1.0 counterpart in this repo, the two differ in formatting, in comments, and in fixes made after the migration.

The fixtures must match the codemod's output byte for byte, and that output is not Biome-formatted. `packages/codemod/biome.json` extends the root config and excludes `tests/fixtures`, and `tsconfig.json` excludes them too.

## CLI notes

`main` saves the changed files before it prints the report, so a reader that closes the pipe early loses no write. The 0.8 example run found this: a `Select-Object -First` in PowerShell stopped the process mid-report, and the files after that point were not saved.

## Build note

The bin's shebang is the first line of `src/cli.ts`, which rolldown keeps. tsdown's `banner` option cannot target one chunk in 0.22: `resolveChunkAddon` replaces a banner function with its first result, so every later chunk gets that one.
