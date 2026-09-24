# @kontsedal/olas-codemod

Upgrades an [Olas](../..) app from 0.8 to 1.0. The codemod rewrites every rename that is mechanical, and it prints a TODO list of the sites that need a human.

```bash
npx @kontsedal/olas-codemod 1.0
```

## Before you run it

- **Start from a clean git tree.** The codemod edits files in place, and `git diff` is how you review what it did.
- **Keep the 0.8 packages installed.** The type-driven rewrites recognize the 0.8 types, such as a root with `__debug`, or a form whose `value` is a signal. Against the 1.0 types they find nothing. The CLI warns when it finds `@kontsedal/olas-core` 1.x installed. Upgrade the packages after the codemod has run.
- **Run it once.** A second run can undo part of the first. After `form.value.value` becomes `form.value`, the 0.8 types still read `form.value` as a signal.
- **Run your formatter after it.** The codemod appends the imports it adds without sorting them, and it does not reflow a line it lengthens.
- **Review the diff, then finish the TODOs.** Typecheck against 1.0 afterwards. The compiler finds what neither the codemod nor its TODO list saw.

## Usage

```bash
npx @kontsedal/olas-codemod 1.0 [--tsconfig <path>] [--dry] [paths...]
```

| Argument | Meaning |
|---|---|
| `1.0` | The migration to run. It is the only one. |
| `--tsconfig <path>` | The project to load. The default is `./tsconfig.json`. A solution-style config with only `references` has no files, so point at the one that includes your sources, such as `tsconfig.app.json`. |
| `--dry` | Print the summary and the TODOs, and write nothing. |
| `paths` | Rewrite only the files under these paths. The whole project still loads, for its types. |

With no tsconfig, the codemod loads every source file under the working directory, outside `node_modules`.

It prints one row per transform, with the files and sites it changed and the TODOs it reported. Then it lists the changed files, and then every TODO as `file:line — transform: what to do`. The exit code is 0 when the run finishes, TODOs or not, and 1 for a usage error or a project with no source files.

## What it rewrites

The transforms run in this order. The type-driven ones run first, while the code still resolves the 0.8 types.

| Transform | Rewrites |
|---|---|
| `forms` | `form.value.value` → `form.value`, and `useValue(form.value)` → `useValue(form)`, for a `Form` or `FieldArray`. `resetWithInitial` → `setAsInitial`. |
| `async-state` | `subscription.promise()` → `subscription.firstValue()`. |
| `react-mutation` | `useMutation`'s `mutateAsync` → `run`. A `mutate(...)` whose promise the code awaits, returns or passes on → `run(...)`. A `mutate(...)` statement stays `mutate`, which is fire-and-forget in 1.0. |
| `suspend-options` | `root.suspend({ maxIdle })` → `root.suspend({ maxIdleTime })`. |
| `error-context` | `ErrorContext.queryKey` → `key`, and `MutationDisposedError.mutationName` → `mutationId`. |
| `entities` | `entitiesPlugin([Post])` → `entitiesPlugin({ entities: [Post] })`. The store's `invalidate` → `remove`. |
| `mutation-queue` | `mutationQueuePlugin({ adapter })` → `mutationQueuePlugin({ storage })`. |
| `removed-apis` | Nothing. It reports each import of a removed core export. |
| `root-api` | `root.increment()` → `root.api.increment()`, where the root's type proves `increment` is api. `root.__debug` → `root.debug`. |
| `ctx-primitives` | `ctx.field(...)` → `createField(ctx, ...)`, and likewise `form`, `fieldArray`, `cache`, `use` (→ `createQuery`), `mutation` and `bindQuery`. `ctx.signal` → `signal` and `ctx.computed` → `computed`. It adds the imports. |
| `create-field` | `createField(ctx, '', [required()], { validateOn })` → `createField(ctx, '', { validators: [required()], validateOn })`. |
| `identity-meta` | `queryId` → `id` and `crossTab` → `meta: { crossTab }` on `defineQuery` and `defineInfiniteQuery`. `mutationId` → `id`, `persist` → `meta: { persist }`, and `name` dropped on mutations. `createMutation(ctx, { ...def, onSuccess })` → `createMutation(ctx, def, { onSuccess })`. |
| `mutate-context` | `mutate: (vars, signal) => …` → `mutate: (vars, { signal }) => …`, and `createCache(ctx, (signal) => …)` → `createCache(ctx, ({ signal }) => …)`. |
| `root-options` | `createRoot(app, options)` gains `queries: queryEngine()`. `defaultQueryOptions` and the `refetchOnWindowFocus` and `refetchOnReconnect` flags move into `queryEngine({ defaults })`. The router's `scopes: adapter.scopes` → `plugins: [adapter.plugin]`. The same applies to a `HydrationBoundary`'s `options`, and `createTestController` moves its defaults. |
| `persist` | `localStorageAdapter` → `localStorageAdapter()`. `clearPersisted(storage, prefix, onError)` → `clearPersisted(storage, { prefix, onError })`. |
| `renames` | `use` → `useValue`, `KeepAlive` → `SuspendOnUnmount`, `usePersisted` → `createPersisted`, `useRealtimePatcher` → `createRealtimePatcher`, `useLiveStream` → `createLiveStream`, `useRealtimeConnection` → `createConnectionState`, `formFromZod` → `createZodForm` with `initials` → `initial`, `selection` → `createSelection`, `DefaultQueryOptions` → `QueryDefaults`, `UseOptions` → `QuerySubscriptionOptions` and `FormFromZodOptions` → `ZodFormOptions`. |
| `use-controller` | `useController(root)` → `root.api`, and the import goes. |

Three rewrites change what the code does, on purpose, to keep what it did in 0.8:

- Every `createRoot` gains a query engine, because every 0.8 root had a query client. A root whose controllers create no query, mutation or bound query can drop it.
- A `defineMutation` without `persist` gains `meta: { persist: true }`, because 0.8 persisted a defined mutation by default and 1.0 does not.
- `clearPersisted()` with no prefix becomes `{ all: true }`, which deletes every key as 0.8 did. The TODO list flags each one.

A shared query with no `queryId` gets a placeholder `id` of `'<path>:<line>'`. The TODO list flags it: an `id` must be stable, unique, and the same in the server and client bundles.

The renames follow the import binding, so a local that shadows an import is left alone. They also follow a local module that re-exports an Olas package under the same name. When the new name is taken in a file, the import keeps the old name as an alias: `import { useValue as use }`.

## What it reports

A TODO is a site the codemod found and did not rewrite, with a one-line hint:

- **Removed with no drop-in replacement:** `ctx.session`, which `ctx.attach` replaces. `root.applyDehydratedEntry`, which `root.hydrate(state)` replaces. `useController` used as a value. The plugin API types and helpers, such as `QueryClientPlugin`, `SetDataEvent`, `stableHash` and `lookupRegisteredQuery`.
- **Changed result shapes:** a `form.submit(...)` whose result the code reads, since it resolves a `SubmitResult` union now. A `mutate(...)` in an arrow body outside a JSX handler, whose caller may await the promise 0.8 returned.
- **Moved services:** a read of the entity store from the `entitiesPlugin` value, which is `ctx.inject(Entities)` now. `replayNow()` on the queue plugin, which is `ctx.inject(MutationQueue).replayNow()` now. An `onReplaySettle` that uses its third argument, now the root's `QueryHost`.
- **Code it cannot see into:** options, specs and fetchers passed through a variable. That covers root options, `createField`'s third argument, `mutationQueuePlugin` and `createZodForm` options, and a query or mutation spec that is not an object literal. It also covers a `mutate` or `createCache` fetcher passed by reference, a spread of a root, and destructuring that mixes root controls with api members.
- **Hooks on a definition:** `defineMutation` takes no `onSuccess` and the rest in 1.0. The owner passes them as `createMutation(ctx, def, hooks)`.
- **Names in the way:** a local `signal`, `createField` or `queryEngine` that would shadow the import the rewrite needs.
- **Placeholders and kept behaviour:** each generated query `id`, and each `clearPersisted` that keeps 0.8's delete-everything scope or takes a prefix that may be empty.

## What it leaves out

These changes are not mechanical, and the codemod neither rewrites nor reports them:

- **Custom plugins.** The plugin contract was redesigned, so a `QueryClientPlugin` object needs a rewrite to `definePlugin({ name, setup(host) })`. The codemod reports the imports of the old types only.
- **Cross-tab defaults.** `crossTabPlugin` now mirrors only the app's own writes. Writes from other plugins opt in through `origins`.
- **Unbound query helpers.** `userQuery.invalidate(...)` and the others throw once more than one root has touched the query. The types cannot tell how many roots a call site sees.
- **A root read through a type query or an element access.** `typeof root.count` and `root['count']` stay as they are.
- **Typed `useRoot()`.** The `Register` augmentation is optional, and `useRoot<Api>()` still works.

## Programmatic use

```ts
import { Project } from 'ts-morph'
import { runCodemod, selectFiles } from '@kontsedal/olas-codemod'

const project = new Project({ tsConfigFilePath: 'tsconfig.json' })
const result = runCodemod(selectFiles(project), { rootDir: process.cwd() })
for (const todo of result.todos) console.log(`${todo.file}:${todo.line} ${todo.reason}`)
await Promise.all(result.changed.map((file) => file.save()))
```

`runCodemod` edits the files in memory and saves nothing. Each transform is also exported on its own, with a `run(files, { rootDir })` that returns `{ changed, todos }`.
