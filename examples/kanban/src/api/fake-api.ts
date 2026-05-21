/**
 * In-memory fake API. Per-tab — each tab maintains its own world. Cross-tab
 * convergence comes from the `crossTabPlugin` replaying cache writes; the
 * realtime channel layers on top so receivers can react to remote changes
 * (e.g. log a "another user moved this card" entry).
 *
 * Latency, failure injection, and pagination are all knobs the demo's
 * Debug menu surfaces.
 */

import type {
  ArchivePage,
  Board,
  BoardSummary,
  Card,
  Column,
  Comment,
  Label,
  SearchResults,
  Subtask,
  User,
} from './types'

const ARCHIVE_PAGE = 8

export type CreateCardInput = {
  columnId: string
  title: string
  description: string
  priority: Card['priority']
  dueDate: string | null
  assigneeIds: string[]
  labelIds: string[]
  subtasks: Subtask[]
}

export type SaveCardInput = {
  id: string
  title: string
  description: string
  priority: Card['priority']
  dueDate: string | null
  assigneeIds: string[]
  labelIds: string[]
  subtasks: Subtask[]
}

export type Api = {
  // queries
  listBoards(signal?: AbortSignal): Promise<BoardSummary[]>
  getBoard(boardId: string, signal?: AbortSignal): Promise<Board>
  listUsers(signal?: AbortSignal): Promise<User[]>
  listLabels(signal?: AbortSignal): Promise<Label[]>
  listComments(cardId: string, signal?: AbortSignal): Promise<Comment[]>
  getArchive(boardId: string, cursor: number, signal?: AbortSignal): Promise<ArchivePage>
  search(boardId: string, q: string, signal?: AbortSignal): Promise<SearchResults>
  /** Reject if `title` is already used by a non-archived card on `boardId`. */
  isCardTitleAvailable(
    boardId: string,
    title: string,
    excludeCardId: string | null,
    signal?: AbortSignal,
  ): Promise<boolean>

  // mutations
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
  saveCard(boardId: string, input: SaveCardInput, signal?: AbortSignal): Promise<Card>
  createCard(boardId: string, input: CreateCardInput, signal?: AbortSignal): Promise<Card>
  createColumn(boardId: string, title: string, hue: number, signal?: AbortSignal): Promise<Column>
  archiveCard(boardId: string, cardId: string, signal?: AbortSignal): Promise<void>
  restoreCard(
    boardId: string,
    cardId: string,
    columnId: string,
    signal?: AbortSignal,
  ): Promise<Card>
  addComment(cardId: string, authorId: string, body: string, signal?: AbortSignal): Promise<Comment>
  updateUser(user: User, signal?: AbortSignal): Promise<User>
  updateLabel(label: Label, signal?: AbortSignal): Promise<Label>

  // test hooks
  failNextWrite: boolean
  failNextNWrites(n: number): void
  setLatency(ms: number): void
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
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

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

const seedUsers = (): User[] => [
  { id: 'u_ada', name: 'Ada Lovelace', hue: 295 },
  { id: 'u_grace', name: 'Grace Hopper', hue: 165 },
  { id: 'u_alan', name: 'Alan Turing', hue: 210 },
  { id: 'u_linus', name: 'Linus Torvalds', hue: 30 },
  { id: 'u_marg', name: 'Margaret Hamilton', hue: 350 },
]

const seedLabels = (): Label[] => [
  { id: 'l_bug', name: 'Bug', hue: 18 },
  { id: 'l_feat', name: 'Feature', hue: 295 },
  { id: 'l_chore', name: 'Chore', hue: 60 },
  { id: 'l_docs', name: 'Docs', hue: 215 },
  { id: 'l_design', name: 'Design', hue: 320 },
  { id: 'l_perf', name: 'Performance', hue: 155 },
]

/**
 * Seed two boards so the board-switcher in the sidebar isn't a one-entry
 * placeholder. The first one's the headline; the second is a smaller
 * "Personal" board to show the switch path works.
 */
const seed = () => {
  const users = seedUsers()
  const labels = seedLabels()
  const now = Date.now()
  const day = 86_400_000

  const c = (id: string, columnId: string, title: string, overrides: Partial<Card> = {}): Card => ({
    id,
    columnId,
    title,
    description: '',
    priority: 'med',
    dueDate: null,
    assigneeIds: [],
    labelIds: [],
    subtasks: [],
    commentsCount: 0,
    createdAt: now - Math.floor(Math.random() * 14 * day),
    archivedAt: null,
    ...overrides,
  })

  const b1Cards: Card[] = [
    c('c_api', 'b1_todo', 'Stabilize public API surface', {
      description: 'Finalize spec wording; freeze module boundaries before RC.',
      priority: 'urgent',
      dueDate: new Date(now + 2 * day).toISOString().slice(0, 10),
      assigneeIds: ['u_ada', 'u_grace'],
      labelIds: ['l_feat', 'l_docs'],
      subtasks: [
        { text: 'audit each package’s index.ts', done: true },
        { text: 'cross-check against SPEC.md', done: false },
        { text: 'flag missing types', done: false },
      ],
      commentsCount: 2,
    }),
    c('c_perf', 'b1_todo', 'Investigate selector re-render storms', {
      description: 'Profile the wide-list view; rule out double subscriptions.',
      priority: 'high',
      assigneeIds: ['u_alan'],
      labelIds: ['l_bug', 'l_perf'],
      subtasks: [{ text: 'reproduce locally', done: false }],
      commentsCount: 1,
    }),
    c('c_drag', 'b1_doing', 'Smoother drag-drop physics', {
      description: 'Switch from snap-to-grid to easing on release.',
      priority: 'med',
      assigneeIds: ['u_linus'],
      labelIds: ['l_design'],
      subtasks: [
        { text: 'pick easing curve', done: true },
        { text: 'tune drop bounce', done: false },
      ],
    }),
    c('c_realtime', 'b1_doing', 'Realtime activity feed', {
      description: 'Show remote users moving cards live.',
      priority: 'high',
      assigneeIds: ['u_marg'],
      labelIds: ['l_feat'],
      subtasks: [{ text: 'pipe events from broadcast', done: true }],
      commentsCount: 3,
    }),
    c('c_themes', 'b1_review', 'Polish theme tokens', {
      description: 'Light + dark + density modes; check focus ring contrast.',
      priority: 'med',
      assigneeIds: ['u_ada'],
      labelIds: ['l_design', 'l_chore'],
    }),
    c('c_release', 'b1_done', 'Release plan v0.2', {
      description: 'Tag, changelog, GitHub release.',
      priority: 'low',
      assigneeIds: ['u_grace'],
      labelIds: ['l_chore'],
      subtasks: [{ text: 'open changelog PR', done: true }],
    }),
    c('c_old1', 'b1_done', 'Initial scaffolding', {
      priority: 'low',
      archivedAt: now - 20 * day,
      assigneeIds: ['u_ada'],
      labelIds: ['l_chore'],
    }),
    c('c_old2', 'b1_done', 'Bootstrap Vite config', {
      priority: 'low',
      archivedAt: now - 18 * day,
      assigneeIds: ['u_linus'],
      labelIds: ['l_chore'],
    }),
    c('c_old3', 'b1_done', 'Pick package manager', {
      priority: 'low',
      archivedAt: now - 24 * day,
    }),
  ]

  const b1 = (): Board => ({
    id: 'b1',
    name: 'Olas Roadmap',
    description: 'The flagship project tracker.',
    hue: 295,
    columns: [
      {
        id: 'b1_todo',
        boardId: 'b1',
        title: 'Backlog',
        hue: 220,
        cardIds: b1Cards.filter((c) => c.columnId === 'b1_todo' && !c.archivedAt).map((c) => c.id),
      },
      {
        id: 'b1_doing',
        boardId: 'b1',
        title: 'In progress',
        hue: 60,
        cardIds: b1Cards.filter((c) => c.columnId === 'b1_doing' && !c.archivedAt).map((c) => c.id),
      },
      {
        id: 'b1_review',
        boardId: 'b1',
        title: 'In review',
        hue: 295,
        cardIds: b1Cards
          .filter((c) => c.columnId === 'b1_review' && !c.archivedAt)
          .map((c) => c.id),
      },
      {
        id: 'b1_done',
        boardId: 'b1',
        title: 'Shipped',
        hue: 155,
        cardIds: b1Cards.filter((c) => c.columnId === 'b1_done' && !c.archivedAt).map((c) => c.id),
      },
    ],
    cards: Object.fromEntries(b1Cards.filter((c) => !c.archivedAt).map((c) => [c.id, c])),
  })

  const b2Cards: Card[] = [
    c('p_groceries', 'b2_todo', 'Groceries', {
      priority: 'low',
      subtasks: [
        { text: 'oats', done: false },
        { text: 'apples', done: false },
      ],
      assigneeIds: ['u_ada'],
    }),
    c('p_run', 'b2_doing', 'Train for the 10k', {
      priority: 'med',
      labelIds: ['l_chore'],
      assigneeIds: ['u_ada'],
    }),
    c('p_book', 'b2_done', 'Finish "Crystal Society"', {
      priority: 'low',
      assigneeIds: ['u_ada'],
    }),
  ]

  const b2 = (): Board => ({
    id: 'b2',
    name: 'Personal',
    description: 'Quiet little board for the off-hours.',
    hue: 155,
    columns: [
      {
        id: 'b2_todo',
        boardId: 'b2',
        title: 'To do',
        hue: 220,
        cardIds: b2Cards.filter((c) => c.columnId === 'b2_todo' && !c.archivedAt).map((c) => c.id),
      },
      {
        id: 'b2_doing',
        boardId: 'b2',
        title: 'Doing',
        hue: 60,
        cardIds: b2Cards.filter((c) => c.columnId === 'b2_doing' && !c.archivedAt).map((c) => c.id),
      },
      {
        id: 'b2_done',
        boardId: 'b2',
        title: 'Done',
        hue: 155,
        cardIds: b2Cards.filter((c) => c.columnId === 'b2_done' && !c.archivedAt).map((c) => c.id),
      },
    ],
    cards: Object.fromEntries(b2Cards.filter((c) => !c.archivedAt).map((c) => [c.id, c])),
  })

  const archive: Record<string, Card[]> = {
    b1: b1Cards
      .filter((c) => c.archivedAt != null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    b2: [],
  }

  // Add some more archive padding so the infinite query has more than one page.
  for (let i = 0; i < 16; i += 1) {
    archive.b1!.push({
      ...c(`c_arc_${i}`, 'b1_done', `Pre-launch chore #${i + 1}`, {
        priority: 'low',
        archivedAt: now - (30 + i) * day,
      }),
    })
  }
  archive.b1!.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))

  const commentsByCard: Record<string, Comment[]> = {
    c_api: [
      {
        id: uid('cm'),
        cardId: 'c_api',
        authorId: 'u_ada',
        body: 'Pinning down the surface this week.',
        createdAt: now - 3 * 3600 * 1000,
      },
      {
        id: uid('cm'),
        cardId: 'c_api',
        authorId: 'u_grace',
        body: 'Will review once the diff lands.',
        createdAt: now - 1 * 3600 * 1000,
      },
    ],
    c_perf: [
      {
        id: uid('cm'),
        cardId: 'c_perf',
        authorId: 'u_alan',
        body: 'Reproduces on Chrome 142.',
        createdAt: now - 6 * 3600 * 1000,
      },
    ],
    c_realtime: [
      {
        id: uid('cm'),
        cardId: 'c_realtime',
        authorId: 'u_marg',
        body: 'Tied the patcher to the channel — works.',
        createdAt: now - 12 * 3600 * 1000,
      },
      {
        id: uid('cm'),
        cardId: 'c_realtime',
        authorId: 'u_ada',
        body: 'Beautiful. Tests next.',
        createdAt: now - 8 * 3600 * 1000,
      },
      {
        id: uid('cm'),
        cardId: 'c_realtime',
        authorId: 'u_grace',
        body: 'Don’t forget the offline case.',
        createdAt: now - 1 * 3600 * 1000,
      },
    ],
  }

  return {
    boards: { b1: b1(), b2: b2() } as Record<string, Board>,
    archive,
    users,
    labels,
    commentsByCard,
  }
}

export function createFakeApi(): Api {
  const state = seed()
  let latency = 60
  let armedFailures = 0
  const shouldFail = (): boolean => {
    if (api.failNextWrite) {
      api.failNextWrite = false
      return true
    }
    if (armedFailures > 0) {
      armedFailures -= 1
      return true
    }
    return false
  }

  const api: Api = {
    failNextWrite: false,
    failNextNWrites(n) {
      armedFailures = Math.max(0, Math.floor(n))
    },
    setLatency(ms) {
      latency = ms
    },

    async listBoards(signal) {
      await delay(latency, signal)
      return Object.values(state.boards).map(({ id, name, hue }) => ({ id, name, hue }))
    },

    async getBoard(boardId, signal) {
      await delay(latency, signal)
      const b = state.boards[boardId]
      if (!b) throw new Error(`No board ${boardId}`)
      return clone(b)
    },

    async listUsers(signal) {
      await delay(latency, signal)
      return clone(state.users)
    },
    async listLabels(signal) {
      await delay(latency, signal)
      return clone(state.labels)
    },

    async listComments(cardId, signal) {
      await delay(latency, signal)
      return clone(state.commentsByCard[cardId] ?? [])
    },

    async getArchive(boardId, cursor, signal) {
      await delay(latency, signal)
      const list = state.archive[boardId] ?? []
      const slice = list.slice(cursor, cursor + ARCHIVE_PAGE)
      return {
        items: clone(slice),
        nextCursor: cursor + ARCHIVE_PAGE >= list.length ? null : cursor + ARCHIVE_PAGE,
      }
    },

    async search(boardId, q, signal) {
      // Slower than reads so two rapid calls overlap — exercises latest-wins.
      await delay(latency * 3, signal)
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const needle = q.trim().toLowerCase()
      if (needle === '') return { q, cardIds: Object.keys(board.cards) }
      const hit = Object.values(board.cards).filter(
        (c) =>
          c.title.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle),
      )
      return { q, cardIds: hit.map((c) => c.id) }
    },

    async isCardTitleAvailable(boardId, title, excludeCardId, signal) {
      // Faster than the main reads so the debouncedValidator perceptibly resolves.
      await delay(latency, signal)
      const board = state.boards[boardId]
      if (!board) return true
      const t = title.trim().toLowerCase()
      if (t === '') return true
      return !Object.values(board.cards).some(
        (c) => c.id !== excludeCardId && c.title.trim().toLowerCase() === t,
      )
    },

    async reorderColumn(boardId, columnId, cardIds, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('reorderColumn failed (simulated)')
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const col = board.columns.find((c) => c.id === columnId)
      if (!col) throw new Error(`No column ${columnId}`)
      col.cardIds = cardIds.slice()
    },

    async moveCard(boardId, cardId, fromColumnId, toColumnId, toIndex, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('moveCard failed (simulated)')
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const from = board.columns.find((c) => c.id === fromColumnId)
      const to = board.columns.find((c) => c.id === toColumnId)
      if (!from || !to) throw new Error('Unknown column')
      from.cardIds = from.cardIds.filter((id) => id !== cardId)
      const dedup = to.cardIds.filter((id) => id !== cardId)
      to.cardIds = [...dedup.slice(0, toIndex), cardId, ...dedup.slice(toIndex)]
      const card = board.cards[cardId]
      if (card) card.columnId = toColumnId
    },

    async saveCard(boardId, input, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('saveCard failed (simulated)')
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const existing = board.cards[input.id]
      if (!existing) throw new Error(`No card ${input.id}`)
      const next: Card = { ...existing, ...input }
      board.cards[input.id] = next
      return clone(next)
    },

    async createCard(boardId, input, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('createCard failed (simulated)')
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const column = board.columns.find((c) => c.id === input.columnId)
      if (!column) throw new Error(`No column ${input.columnId}`)
      const card: Card = {
        id: uid('c'),
        columnId: input.columnId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        dueDate: input.dueDate,
        assigneeIds: input.assigneeIds,
        labelIds: input.labelIds,
        subtasks: input.subtasks,
        commentsCount: 0,
        createdAt: Date.now(),
        archivedAt: null,
      }
      board.cards[card.id] = card
      column.cardIds = [card.id, ...column.cardIds]
      return clone(card)
    },

    async createColumn(boardId, title, hue, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('createColumn failed (simulated)')
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const column: Column = {
        id: `${boardId}_${uid('col')}`,
        boardId,
        title,
        hue,
        cardIds: [],
      }
      board.columns.push(column)
      return clone(column)
    },

    async archiveCard(boardId, cardId, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('archiveCard failed (simulated)')
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const card = board.cards[cardId]
      if (!card) throw new Error(`No card ${cardId}`)
      card.archivedAt = Date.now()
      const column = board.columns.find((c) => c.id === card.columnId)
      if (column) column.cardIds = column.cardIds.filter((id) => id !== cardId)
      delete board.cards[cardId]
      if (state.archive[boardId] === undefined) state.archive[boardId] = []
      state.archive[boardId]!.unshift(card)
    },

    async restoreCard(boardId, cardId, columnId, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('restoreCard failed (simulated)')
      const list = state.archive[boardId] ?? []
      const idx = list.findIndex((c) => c.id === cardId)
      if (idx < 0) throw new Error(`No archived card ${cardId}`)
      const card = list[idx]!
      list.splice(idx, 1)
      const board = state.boards[boardId]
      if (!board) throw new Error(`No board ${boardId}`)
      const column = board.columns.find((c) => c.id === columnId)
      if (!column) throw new Error(`No column ${columnId}`)
      card.archivedAt = null
      card.columnId = columnId
      board.cards[card.id] = card
      column.cardIds = [card.id, ...column.cardIds]
      return clone(card)
    },

    async addComment(cardId, authorId, body, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('addComment failed (simulated)')
      const comment: Comment = {
        id: uid('cm'),
        cardId,
        authorId,
        body,
        createdAt: Date.now(),
      }
      if (state.commentsByCard[cardId] === undefined) state.commentsByCard[cardId] = []
      const list = state.commentsByCard[cardId]!
      list.push(comment)
      // Mirror commentsCount on every visible card across all boards.
      for (const board of Object.values(state.boards)) {
        const c = board.cards[cardId]
        if (c) c.commentsCount = list.length
      }
      return clone(comment)
    },

    async updateUser(user, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('updateUser failed (simulated)')
      const idx = state.users.findIndex((u) => u.id === user.id)
      if (idx >= 0) state.users[idx] = { ...user }
      else state.users.push({ ...user })
      return clone(user)
    },

    async updateLabel(label, signal) {
      await delay(latency, signal)
      if (shouldFail()) throw new Error('updateLabel failed (simulated)')
      const idx = state.labels.findIndex((l) => l.id === label.id)
      if (idx >= 0) state.labels[idx] = { ...label }
      else state.labels.push({ ...label })
      return clone(label)
    },
  }
  return api
}
