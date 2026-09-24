// Controller tests for the virtualized-table example. Plain Node, no DOM and
// no React: everything the table does lives in `tableController`, so it tests
// without a renderer. `createTestController` builds an isolated root around it.
import type { ReadSignal } from '@kontsedal/olas-core'
import { createTestController } from '@kontsedal/olas-core/testing'
import { describe, expect, test, vi } from 'vitest'
import { createFakeApi, type Issue, type Status } from '../src/api'
import { tableController } from '../src/controllers/table'

const ROWS = 200

const setup = () => {
  const api = createFakeApi()
  api.setLatency(0)
  const root = createTestController(tableController, {
    props: { rowCount: ROWS },
    deps: { api },
  })
  const table = root.api
  const idAt = (index: number): string => {
    const id = table.visibleIds.value[index]
    if (id === undefined) throw new Error(`no visible row at ${index}`)
    return id
  }
  const slot = (id: string): ReadSignal<Issue> => {
    const sig = table.rowSignal(id)
    if (sig === null) throw new Error(`no row ${id}`)
    return sig
  }
  // The generator is seeded, so a second call returns the rows the
  // controller was built from. Only `updatedAt` differs: it is relative to now.
  const seeded = api.generateIssues(ROWS)
  return { api, root, table, idAt, slot, seeded }
}

/** A status the row does not have, so an edit is a real change. */
const otherThan = (status: Status): Status => (status === 'done' ? 'todo' : 'done')

describe('tableController rows', () => {
  test('seeds one signal per generated row, in order', () => {
    const { root, table, slot, seeded } = setup()
    expect(table.totalRowCount).toBe(ROWS)
    expect(table.rowCount.value).toBe(ROWS)
    expect(table.visibleIds.value).toEqual(seeded.map((issue) => issue.id))
    const first = seeded[0]
    expect(slot(first?.id ?? '').value).toMatchObject({
      id: first?.id,
      title: first?.title,
      status: first?.status,
    })
    expect(table.rowSignal('missing')).toBeNull()
    root.dispose()
  })

  test('a row write lands on that row signal alone', async () => {
    const { root, table, idAt, slot } = setup()
    const edited = slot(idAt(0))
    const neighbour = slot(idAt(1))
    const neighbourBefore = neighbour.value
    const next = otherThan(edited.value.status)

    const editedSeen: Issue[] = []
    edited.subscribeChanges((issue) => editedSeen.push(issue))
    const neighbourSeen = vi.fn()
    neighbour.subscribeChanges(neighbourSeen)
    const idsSeen = vi.fn()
    table.visibleIds.subscribeChanges(idsSeen)

    const startedAt = Date.now()
    await table.updateStatus.run({ id: idAt(0), status: next })

    expect(editedSeen).toHaveLength(1)
    expect(edited.value.status).toBe(next)
    expect(edited.value.updatedAt).toBeGreaterThanOrEqual(startedAt)
    // The map still hands out the same signal: the row was written in place.
    expect(table.rowSignal(idAt(0))).toBe(edited)
    // Nothing else moved, so a virtualized view re-renders one row.
    expect(neighbour.value).toBe(neighbourBefore)
    expect(neighbourSeen).not.toHaveBeenCalled()
    expect(idsSeen).not.toHaveBeenCalled()
    root.dispose()
  })

  test('a write to an id the table does not hold inserts nothing', async () => {
    const { root, table } = setup()
    await table.updateStatus.run({ id: 'missing', status: 'done' })
    expect(table.rowSignal('missing')).toBeNull()
    expect(table.rowCount.value).toBe(ROWS)
    root.dispose()
  })
})

describe('tableController optimistic edit', () => {
  test('an edit shows at once, and stays once the server confirms it', async () => {
    const { root, table, idAt, slot } = setup()
    const row = slot(idAt(3))
    const next = otherThan(row.value.status)

    const run = table.updateStatus.run({ id: idAt(3), status: next })
    // Optimistic: the row signal already holds the guess.
    expect(row.value.status).toBe(next)
    expect(table.updateStatus.isPending.value).toBe(true)

    await run
    expect(table.updateStatus.isPending.value).toBe(false)
    expect(row.value.status).toBe(next)
    root.dispose()
  })

  test('a rejected edit rolls its row back to the value it replaced', async () => {
    const { api, root, table, idAt, slot } = setup()
    const row = slot(idAt(3))
    const before = row.value
    api.failNextWrite = true

    const run = table.updateStatus.run({ id: idAt(3), status: otherThan(before.status) })
    expect(row.value.status).toBe(otherThan(before.status))

    await expect(run).rejects.toThrow('saveStatus failed (simulated)')
    expect(row.value).toBe(before)
    expect(table.updateStatus.error.value).toBeInstanceOf(Error)
    root.dispose()
  })
})

describe('tableController selection', () => {
  test('a shift-click selects the range from the anchor, a meta-click toggles one', () => {
    const { root, table, idAt } = setup()
    const ordered = table.visibleIds.value

    table.selection.handleClick(idAt(2), {}, ordered)
    table.selection.handleClick(idAt(6), { shift: true }, ordered)
    expect([...table.selection.selectedIds.value]).toEqual(ordered.slice(2, 7))

    table.selection.handleClick(idAt(9), { meta: true }, ordered)
    expect(table.selection.size.value).toBe(6)
    expect(table.selection.isSelected(idAt(9)).value).toBe(true)
    expect(table.selection.isSelected(idAt(7)).value).toBe(false)
    root.dispose()
  })

  test('a range over the filtered list takes only the rows the filter shows', () => {
    const { root, table, slot } = setup()
    table.filter.set('cache')
    const ordered = table.visibleIds.value
    expect(ordered.length).toBeGreaterThan(4)

    const [from, to] = [ordered[0] ?? '', ordered[3] ?? '']
    table.selection.handleClick(from, {}, ordered)
    table.selection.handleClick(to, { shift: true }, ordered)

    const selected = [...table.selection.selectedIds.value]
    expect(selected).toEqual(ordered.slice(0, 4))
    for (const id of selected) expect(slot(id).value.title.toLowerCase()).toContain('cache')
    root.dispose()
  })

  test('bulk apply writes every selected row, then clears the selection', async () => {
    const { root, table, idAt, slot } = setup()
    const chosen = table.visibleIds.value.slice(10, 20)
    const outside = slot(idAt(0)).value
    table.selection.selectAll(chosen)

    await table.bulkSetStatus('review')

    for (const id of chosen) expect(slot(id).value.status).toBe('review')
    expect(slot(idAt(0)).value).toBe(outside)
    expect(table.selection.size.value).toBe(0)
    root.dispose()
  })

  test('one failed write in a bulk apply rolls back only its own row', async () => {
    const { api, root, table, slot } = setup()
    const chosen = table.visibleIds.value.slice(10, 20)
    const before = new Map(chosen.map((id) => [id, slot(id).value]))
    table.selection.selectAll(chosen)
    api.failNextWrite = true

    // Each row is its own run, so the batch settles rather than rejecting.
    await table.bulkSetStatus('review')

    const rolledBack = chosen.filter((id) => slot(id).value === before.get(id))
    expect(rolledBack).toHaveLength(1)
    for (const id of chosen) {
      if (!rolledBack.includes(id)) expect(slot(id).value.status).toBe('review')
    }
    expect(table.selection.size.value).toBe(0)
    root.dispose()
  })

  test('bulk apply with nothing selected sends no write', async () => {
    const { api, root, table } = setup()
    const save = vi.spyOn(api, 'saveStatus')
    await table.bulkSetStatus('done')
    expect(save).not.toHaveBeenCalled()
    root.dispose()
  })
})

describe('tableController title filter', () => {
  test('keeps the rows whose title contains the query, in order', () => {
    const { root, table, seeded } = setup()
    table.filter.set('cache')
    const expected = seeded
      .filter((issue) => issue.title.toLowerCase().includes('cache'))
      .map((issue) => issue.id)
    expect(expected.length).toBeGreaterThan(0)
    expect(expected.length).toBeLessThan(ROWS)
    expect(table.visibleIds.value).toEqual(expected)
    expect(table.rowCount.value).toBe(expected.length)
    expect(table.totalRowCount).toBe(ROWS)
    root.dispose()
  })

  test('ignores case and surrounding space', () => {
    const { root, table } = setup()
    table.filter.set('cache')
    const lower = table.visibleIds.value
    table.filter.set('  CACHE ')
    expect(table.visibleIds.value).toEqual(lower)
    root.dispose()
  })

  test('an empty query shows every row, and no match shows none', () => {
    const { root, table } = setup()
    table.filter.set('no title says this')
    expect(table.visibleIds.value).toEqual([])
    expect(table.rowCount.value).toBe(0)
    table.filter.set('   ')
    expect(table.rowCount.value).toBe(ROWS)
    root.dispose()
  })
})
