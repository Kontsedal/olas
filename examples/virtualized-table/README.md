# Virtualized Table — 50,000 rows

A React example that demonstrates the SPEC §11.1 **"rows are data"** pattern:
items live in a `Map<id, Signal<Item>>` owned by a single list-level
controller, not as one controller per row.

```bash
pnpm -F @kontsedal/olas-example-virtualized-table dev
```

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
