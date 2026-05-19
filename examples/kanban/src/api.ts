// Fake Kanban API — in-memory store with tunable latency and a failure switch.
//
// The structure is intentionally simple: a Board is a list of Columns plus a
// flat dictionary of Cards. Each column references cards by id. Mutations
// patch the store and resolve; `failNextWrite` flips one write into an error
// so tests can exercise rollback paths.

export type Subtask = { text: string; done: boolean }

export type Priority = 'low' | 'med' | 'high'

export type Card = {
  id: string
  title: string
  description: string
  subtasks: Subtask[]
  priority: Priority
  /** ISO date (yyyy-mm-dd) or null. */
  dueDate: string | null
}

export type Column = {
  id: string
  title: string
  cardIds: string[]
}

export type Board = {
  id: string
  title: string
  columns: Column[]
  cards: Record<string, Card>
}

export type SearchResults = {
  query: string
  matches: string[]
}

/** Fields the caller supplies when creating a brand-new card; id is minted by the api. */
export type NewCard = Omit<Card, 'id'>

export type Api = {
  getBoard(id: string, signal?: AbortSignal): Promise<Board>
  moveCard(
    boardId: string,
    cardId: string,
    fromColumnId: string,
    toColumnId: string,
    toIndex: number,
    signal?: AbortSignal,
  ): Promise<void>
  reorderColumn(
    boardId: string,
    columnId: string,
    cardIds: string[],
    signal?: AbortSignal,
  ): Promise<void>
  saveCard(boardId: string, card: Card, signal?: AbortSignal): Promise<Card>
  /** Create a new card; the api mints its id and appends it to `columnId`. */
  createCard(boardId: string, columnId: string, card: NewCard, signal?: AbortSignal): Promise<Card>
  search(boardId: string, query: string, signal?: AbortSignal): Promise<SearchResults>
  /** Test hooks. */
  failNextWrite: boolean
  setLatency(ms: number): void
}

export function createFakeApi(): Api {
  const cards: Record<string, Card> = {
    c1: {
      id: 'c1',
      title: 'Write API spec',
      description: '',
      subtasks: [
        { text: 'draft routes', done: true },
        { text: 'review', done: false },
      ],
      priority: 'high',
      dueDate: '2026-05-22',
    },
    c2: {
      id: 'c2',
      title: 'Set up CI',
      description: 'GitHub Actions',
      subtasks: [{ text: 'cache deps', done: true }],
      priority: 'med',
      dueDate: '2026-05-25',
    },
    c3: {
      id: 'c3',
      title: 'Buy domain',
      description: '',
      subtasks: [{ text: 'short and memorable', done: true }],
      priority: 'low',
      dueDate: null,
    },
    c4: {
      id: 'c4',
      title: 'Migrate logs',
      description: 'from CW to BigQuery',
      subtasks: [{ text: 'export schema', done: false }],
      priority: 'high',
      dueDate: '2026-05-19',
    },
    c5: {
      id: 'c5',
      title: 'Wire metrics',
      description: '',
      subtasks: [{ text: 'choose names', done: false }],
      priority: 'med',
      dueDate: '2026-06-01',
    },
    c6: {
      id: 'c6',
      title: 'Onboarding doc',
      description: '',
      subtasks: [{ text: 'rough outline', done: false }],
      priority: 'low',
      dueDate: null,
    },
  }
  const boards: Record<string, Board> = {
    b1: {
      id: 'b1',
      title: 'Q2 Roadmap',
      columns: [
        { id: 'todo', title: 'To do', cardIds: ['c1', 'c4', 'c6'] },
        { id: 'doing', title: 'In progress', cardIds: ['c2', 'c5'] },
        { id: 'done', title: 'Done', cardIds: ['c3'] },
      ],
      cards,
    },
  }

  let latency = 60
  // Continue ids from the seeded fixture so dev session ids stay readable.
  let cardIdCounter = Object.keys(cards).length
  const api: Api = {
    failNextWrite: false,
    setLatency(ms: number) {
      latency = ms
    },

    async getBoard(id, signal) {
      await delay(latency, signal)
      const b = boards[id]
      if (!b) throw new Error(`No board ${id}`)
      return clone(b)
    },

    async moveCard(boardId, cardId, fromColumnId, toColumnId, toIndex, signal) {
      await delay(latency, signal)
      if (api.failNextWrite) {
        api.failNextWrite = false
        throw new Error('moveCard failed (simulated)')
      }
      const board = boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const from = board.columns.find((c) => c.id === fromColumnId)
      const to = board.columns.find((c) => c.id === toColumnId)
      if (!from || !to) throw new Error('Unknown column')
      from.cardIds = from.cardIds.filter((id) => id !== cardId)
      const dedup = to.cardIds.filter((id) => id !== cardId)
      to.cardIds = [...dedup.slice(0, toIndex), cardId, ...dedup.slice(toIndex)]
    },

    async reorderColumn(boardId, columnId, cardIds, signal) {
      await delay(latency, signal)
      if (api.failNextWrite) {
        api.failNextWrite = false
        throw new Error('reorderColumn failed (simulated)')
      }
      const board = boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const col = board.columns.find((c) => c.id === columnId)
      if (!col) throw new Error(`No column ${columnId}`)
      col.cardIds = cardIds.slice()
    },

    async saveCard(boardId, card, signal) {
      await delay(latency, signal)
      if (api.failNextWrite) {
        api.failNextWrite = false
        throw new Error('saveCard failed (simulated)')
      }
      const board = boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      board.cards[card.id] = { ...card }
      return clone(board.cards[card.id]!)
    },

    async createCard(boardId, columnId, card, signal) {
      await delay(latency, signal)
      if (api.failNextWrite) {
        api.failNextWrite = false
        throw new Error('createCard failed (simulated)')
      }
      const board = boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const column = board.columns.find((c) => c.id === columnId)
      if (!column) throw new Error(`No column ${columnId}`)
      const id = `c${++cardIdCounter}`
      const full: Card = { ...card, id }
      board.cards[id] = full
      column.cardIds = [id, ...column.cardIds]
      return clone(full)
    },

    async search(boardId, query, signal) {
      // Long enough latency that two rapid calls overlap — tests rely on this
      // to demonstrate latest-wins abort.
      await delay(latency * 3, signal)
      const board = boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const q = query.trim().toLowerCase()
      const matches =
        q === ''
          ? Object.keys(board.cards)
          : Object.values(board.cards)
              .filter(
                (c) => c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
              )
              .map((c) => c.id)
      return { query, matches }
    },
  }
  return api
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const id = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(id)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
