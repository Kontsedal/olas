// Table controller — owns the 50k-row dataset as data, not as children.
//
// This is the SPEC §11.1 "rows are data" pattern at scale: each row lives
// in a `Map<id, Signal<Issue>>` so editing one row only invalidates that
// row's signal. A virtualized renderer that mounts at most ~30 rows at a
// time gets per-row reactivity without allocating a controller per row
// (which would churn hundreds of constructions per scroll-second).
//
// Selection ranges + bulk updates leverage `@kontsedal/olas-core`'s `selection`
// composable (SPEC §17.5) over the same row signals — no extra plumbing.

import {
  type Ctx,
  computed,
  defineController,
  type ReadSignal,
  type Signal,
  selection,
  signal,
} from '@kontsedal/olas-core'
import type { Issue, Status } from '../api'

export type TableProps = {
  rowCount: number
}

export const tableController = defineController(
  (ctx: Ctx, props: TableProps) => {
    // Seed once at construction. Generation is sync (no fetch) so we can
    // populate the map without an AsyncState dance. In a real app this would
    // be `ctx.use(issuesQuery)` over an infinite/paginated query.
    const initial = ctx.deps.api.generateIssues(props.rowCount)
    const rowMap = new Map<string, Signal<Issue>>(
      initial.map((row) => [row.id, signal<Issue>(row)]),
    )
    const orderedIds = signal<readonly string[]>(initial.map((r) => r.id))

    const filter = signal('')

    // Filter is title-substring only — keeps the demo simple and lets us
    // peek the row signals without subscribing (so title edits wouldn't
    // re-trigger the filter even if we added them).
    const visibleIds: ReadSignal<readonly string[]> = computed(() => {
      const q = filter.value.trim().toLowerCase()
      if (q === '') return orderedIds.value
      const out: string[] = []
      for (const id of orderedIds.value) {
        const row = rowMap.get(id)?.peek()
        if (row?.title.toLowerCase().includes(q)) {
          out.push(id)
        }
      }
      return out
    })

    const sel = selection<string>()

    // Single-row status update. Returns a Snapshot-shaped object from
    // `onMutate` so the framework's auto-rollback fires on non-abort errors
    // (spec §6.4). The snapshot closure captures `slot` + `prev`, so
    // rollback restores exactly the row that was edited.
    const updateStatus = ctx.mutation<{ id: string; status: Status }, void>({
      name: 'updateStatus',
      concurrency: 'parallel',
      onMutate: ({ id, status }) => {
        const slot = rowMap.get(id)
        if (slot === undefined) return
        const prev = slot.peek()
        slot.set({ ...prev, status, updatedAt: Date.now() })
        return {
          rollback: () => slot.set(prev),
          finalize: () => {},
        }
      },
      mutate: ({ id, status }, abortSignal) => ctx.deps.api.saveStatus(id, status, abortSignal),
    })

    /** Bulk-update every selected row to `status`. Each row is its own run, so
     *  one server failure rolls back only that row, not the whole batch. */
    const bulkSetStatus = async (status: Status): Promise<void> => {
      const ids = [...sel.selectedIds.peek()]
      if (ids.length === 0) return
      await Promise.allSettled(ids.map((id) => updateStatus.run({ id, status })))
      sel.clear()
    }

    return {
      rowCount: computed(() => visibleIds.value.length),
      totalRowCount: props.rowCount,
      visibleIds,
      /** Read a single row signal by id — the view subscribes per-visible-row. */
      rowSignal: (id: string): ReadSignal<Issue> | null => rowMap.get(id) ?? null,
      filter,
      selection: sel,
      updateStatus,
      bulkSetStatus,
    }
  },
  { name: 'table' },
)
