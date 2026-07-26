# Example — virtualized-table (React)

A 50,000-row table that stays smooth because **rows are data, not controllers**
(SPEC §11.1): every item lives in a `Map<id, Signal<Issue>>` owned by a single
list-level controller, so editing one row re-renders one row — and scrolling
allocates zero controllers.

## What this example proves

| Demonstration | How to see it |
|---|---|
| Per-row fine-grained reactivity | Edit one row's status — only that row's render counter ticks. The other ~30 visible rows hold flat. |
| Selection composable at scale | Shift-click two rows hundreds apart to select the range; ⌘/Ctrl-click to toggle. Bulk-edit applies to thousands at once. |
| The controller boundary belongs at the list level | The controller tree (open the devtools panel) has exactly one node for the whole table — no `Row[N]` children. Scrolling allocates zero controllers. |
| Optimistic + manual rollback | Edits are applied to the row signal synchronously; the mutation's `onError` restores the prior value if the fake API rejects. |

## Architecture in one paragraph

`tableController` owns `Map<id, Signal<Issue>>` and a `signal<readonly string[]>`
of ordered ids. The view is `@tanstack/react-virtual` over the ordered ids;
each `<Row id={id} />` calls `api.table.rowSignal(id)` and `use(...)` to
subscribe to its own row. Status edits go through a `parallel` mutation that
writes the row signal in `onMutate` and restores it in `onError`. Selection
is the standard `@kontsedal/olas-core` `selection<string>()` composable; bulk actions
loop selected ids through the same single-row mutation.

## Why not a controller per row?

`@tanstack/react-virtual` mounts and unmounts row components rapidly as the
user scrolls. If each row were its own controller, scrolling fast would
construct and dispose hundreds of controllers per second — real perf pain
and pointless allocation churn. SPEC §11.1 spells this out.

If a row needed row-scoped logic worth a controller (e.g. an inline editor),
the right move is `ctx.attach(rowEditorController, ...)` on demand and
dispose on commit/cancel. The kanban example demonstrates that with
`inlineTitleEditor`.

## Files

- `src/controllers/table.ts` — `tableController`: the `Map<id, Signal<Issue>>`, the ordered-id signal, the title filter, `selection`, and the per-row `parallel` mutation. The whole app's behavior; no DOM imports.
- `src/api.ts` — fake backend: `generateIssues(n)` plus a per-row update that randomly rejects (to exercise rollback), and the `Issue` / `Status` types.
- `src/View/Table.tsx` — `@tanstack/react-virtual` over the ordered ids; mounts ~30 rows at a time.
- `src/View/Row.tsx` — one row. Calls `api.table.rowSignal(id)` + `use(...)` to subscribe to its own signal and nothing else.
- `src/View/App.tsx` — toolbar, bulk-action buttons, and the per-row render counters that prove fine-grained reactivity.
- `src/View/useApi.ts` — typed `useRoot` accessor for the table api.
- `src/app.ts` — composes the root controller.
- `src/main.tsx` — bootstrap: `createRoot` + `<OlasProvider>` + render.

## Run it

```bash
pnpm install
pnpm --filter @kontsedal/olas-example-virtualized-table dev        # vite dev server
pnpm --filter @kontsedal/olas-example-virtualized-table build      # vite build → dist/
pnpm --filter @kontsedal/olas-example-virtualized-table typecheck  # tsc --noEmit
```

Open the printed local URL, scroll hard, and watch the per-row render counters stay still.

## Read order

1. `src/controllers/table.ts` — the "rows are data" controller, top to bottom. This is the point of the example.
2. `src/View/Row.tsx` — how a single row subscribes to just its own signal.
3. `src/View/Table.tsx` — the virtualizer wiring over the ordered ids.
4. `src/View/App.tsx` + `src/main.tsx` — toolbar, bulk actions, and bootstrap.
