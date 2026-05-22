import { computed, signal } from './signals'
import { readOnly } from './signals/readonly'
import type { ReadSignal } from './signals/types'

/**
 * Multi-select state for tables / lists with bulk actions (spec §17.5).
 *
 * Plain function — not bound to `ctx`. Place it in a controller's closure so
 * it dies with the closure. The phantom `T` parameter brands the selection by
 * item type; IDs are always strings.
 */
// biome-ignore lint/correctness/noUnusedVariables: phantom branding param (spec §17.5)
export type Selection<T = unknown> = {
  selectedIds: ReadSignal<ReadonlySet<string>>
  size: ReadSignal<number>
  isSelected(id: string): ReadSignal<boolean>

  select(id: string): void
  deselect(id: string): void
  toggle(id: string): void
  clear(): void
  selectAll(ids: readonly string[]): void

  handleClick(
    id: string,
    mods: { shift?: boolean; meta?: boolean },
    ordered: readonly string[] | ReadonlyMap<string, number>,
  ): void
}

/**
 * Create a `Selection<T>`. Optional `initial` seeds the selected set.
 *
 * `handleClick` encapsulates the standard click semantics:
 * - plain click → select only `id` (anchor moves to `id`)
 * - meta-click  → toggle `id` (anchor moves to `id` on add)
 * - shift-click → range from anchor to `id` along `ordered` (anchor sticks,
 *   so subsequent shift-clicks extend from the same origin)
 *
 * Spec §16.5 / §17.5.
 */
export function selection<T = unknown>(options?: { initial?: readonly string[] }): Selection<T> {
  const ids = signal<ReadonlySet<string>>(new Set(options?.initial))
  let anchor: string | null = options?.initial?.length
    ? (options.initial[options.initial.length - 1] ?? null)
    : null
  // Snapshot of the selection just before the first shift-click of a run.
  // Subsequent shift-clicks re-compute the range against this snapshot so the
  // user can shrink or grow the range. Reset on any non-shift click.
  let preShiftSelection: ReadonlySet<string> | null = null

  const size = computed(() => ids.value.size)

  const isSelected = (id: string): ReadSignal<boolean> => computed(() => ids.value.has(id))

  const select = (id: string): void => {
    const prev = ids.peek()
    if (!prev.has(id)) {
      const next = new Set(prev)
      next.add(id)
      ids.set(next)
    }
    anchor = id
  }

  const deselect = (id: string): void => {
    const prev = ids.peek()
    if (!prev.has(id)) return
    const next = new Set(prev)
    next.delete(id)
    ids.set(next)
    // Clear the anchor if we just removed it — a subsequent shift-click
    // would otherwise range from an id that's no longer in the selection.
    if (anchor === id) anchor = null
  }

  const toggle = (id: string): void => {
    const prev = ids.peek()
    const next = new Set(prev)
    if (prev.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
      anchor = id
    }
    ids.set(next)
  }

  const clear = (): void => {
    if (ids.peek().size === 0) {
      anchor = null
      return
    }
    ids.set(new Set())
    anchor = null
  }

  const selectAll = (incoming: readonly string[]): void => {
    ids.set(new Set(incoming))
    anchor = incoming.length > 0 ? (incoming[incoming.length - 1] ?? null) : null
  }

  const handleClick = (
    id: string,
    mods: { shift?: boolean; meta?: boolean },
    ordered: readonly string[] | ReadonlyMap<string, number>,
  ): void => {
    if (mods.shift && anchor !== null) {
      // Accept either a positional array (back-compat, O(n) lookup) OR a
      // precomputed `Map<id, index>` for O(1) shift-click on large lists
      // (a 100k-row virtualized table doesn't want to scan the array twice
      // per click). The caller decides which to pass — `Map` is cheap to
      // build once when the row list changes.
      let anchorIdx: number
      let targetIdx: number
      let slice: readonly string[]
      if (Array.isArray(ordered)) {
        const arr = ordered as readonly string[]
        anchorIdx = arr.indexOf(anchor)
        targetIdx = arr.indexOf(id)
        if (anchorIdx === -1 || targetIdx === -1) {
          ids.set(new Set([id]))
          anchor = id
          preShiftSelection = null
          return
        }
        const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
        slice = arr.slice(lo, hi + 1)
      } else {
        const map = ordered as ReadonlyMap<string, number>
        anchorIdx = map.get(anchor) ?? -1
        targetIdx = map.get(id) ?? -1
        if (anchorIdx === -1 || targetIdx === -1) {
          ids.set(new Set([id]))
          anchor = id
          preShiftSelection = null
          return
        }
        const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
        // The Map gives O(1) index lookup. To materialise the range we
        // still need keys at [lo, hi]; iterate the insertion-ordered Map
        // once and bail when we've collected enough. The 0..hi prefix is
        // O(hi) — bounded by the range length, not the full list.
        const keys: string[] = []
        let i = 0
        for (const k of map.keys()) {
          if (i >= lo && i <= hi) keys.push(k)
          if (i >= hi) break
          i += 1
        }
        slice = keys
      }
      if (preShiftSelection === null) {
        preShiftSelection = ids.peek()
      }
      const next = new Set(preShiftSelection)
      for (const k of slice) next.add(k)
      ids.set(next)
      // Anchor stays — subsequent shift-clicks extend from the same origin.
      return
    }
    // Any non-shift click ends the shift run.
    preShiftSelection = null
    if (mods.meta) {
      toggle(id)
      return
    }
    ids.set(new Set([id]))
    anchor = id
  }

  return {
    selectedIds: readOnly(ids),
    size,
    isSelected,
    select,
    deselect,
    toggle,
    clear,
    selectAll,
    handleClick,
  }
}
