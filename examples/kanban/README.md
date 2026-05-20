# Example — kanban (React)

A project-board demonstrating Olas's most ambitious surfaces in one place: all
three mutation concurrency modes, optimistic updates with automatic rollback,
nested Zod-validated forms with field arrays, typed cross-tree scopes, and the
live Devtools panel.

## What it shows

- **`ctx.mutation({ concurrency: 'parallel' })`** for `moveCard` — independent moves run concurrently. Optimistic update via `onMutate → boardQuery.setData(...)`; on error, the snapshot is restored via `onError(_, _, snap) => snap?.rollback()`. Aborted runs (supersede / dispose) roll back automatically. Spec §6.3, §6.4.
- **`ctx.mutation({ concurrency: 'latest-wins' })`** for `applyFilter` — rapid keystrokes supersede prior requests; the prior `mutate` observes `signal.aborted` and rejects with `AbortError`. The controller's `filterResults` signal always holds the freshest data.
- **`ctx.mutation({ concurrency: 'serial' })`** for `reorderColumn` — queued runs apply one at a time, in submission order. The test asserts `maxActive === 1` to prove no api call ever overlaps.
- **`formFromZod`** in the card editor — one Zod schema generates the entire form tree (title `Field<string>`, description `Field<string>`, subtasks `FieldArray<Form<...>>`), with validators auto-attached at every leaf.
- **`defineScope`** + `ctx.provide` / `ctx.inject` — `currentBoardScope` lets the card editor controller learn its board id without taking it in props.
- **`AmbientDeps`** module augmentation — `ctx.deps.api` is typed everywhere; no provider plumbing.
- **`<DevtoolsLauncher>`** mounted at the app root — floating launcher with live controller tree, cache timeline, mutation log, field validations.
- **Component testing with `fakeField`** in `tests/CardEditor.test.tsx` — render UI cells against shape-correct fakes; no jsdom-on-the-real-controller needed.

## Files

- `src/api.ts` — in-memory board with tunable latency + `failNextWrite` flag.
- `src/scopes.ts` — `currentBoardScope`.
- `src/query.ts` — `boardQuery` (paginated, `keepPreviousData`).
- `src/schema.ts` — Zod schema feeding `formFromZod` in the card editor.
- `src/controllers/board.ts`, `controllers/cardEditor.ts` — business logic. No React.
- `src/app.ts` — root controller composing the children + scope wiring.
- `src/controller.ts` — barrel re-export for the things UI imports.
- `src/View/App.tsx` — top-level layout, OlasProvider, DevtoolsLauncher.
- `src/View/Board.tsx`, `Column.tsx`, `SearchBar.tsx`, `CardEditor.tsx` — leaf UI.
- `src/main.tsx` — bootstrap.
- `tests/controller.test.ts` — tests covering moveCard rollback, parallel writes, latest-wins abort, serial ordering, and form validation.
- `tests/CardEditor.test.tsx` — component tests using `fakeField`.

## Run it

```bash
pnpm install
pnpm --filter @kontsedal/olas-example-kanban dev        # http://localhost:5181
pnpm --filter @kontsedal/olas-example-kanban test
pnpm --filter @kontsedal/olas-example-kanban typecheck
pnpm --filter @kontsedal/olas-example-kanban build
```

In the dev UI:

- Click **Arm failure** in the header to make the next `moveCard` / `reorderColumn` / `saveCard` fail. Move a card and watch it snap back to its origin — that's the automatic rollback. The mutation log in the Devtools panel records the rollback event.
- Type in the **search** input. Each keystroke triggers a 150ms server "search". With latest-wins, you always see results for the *latest* query, even if you typed fast enough to issue 10 overlapping requests.
- Click a card title to open the editor. Add subtasks, edit text, save. Empty title → validation error; empty subtasks list → top-level form error from the Zod `.min(1)` rule.

## Read order

1. `src/api.ts` (skim) — types and the latency model.
2. `src/controller.ts` top to bottom — query, then the three mutations side by side. This is where the eloquence claim is.
3. `tests/controller.test.ts` — see how each concurrency mode is verified deterministically with `createTestController` + a mocked api.
4. `src/View/App.tsx` and `CardEditor.tsx` — minimal React surface.
