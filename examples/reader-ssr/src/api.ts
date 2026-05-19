// Fake article API — cursor-paginated, deterministic.
//
// `getPage(cursor)` returns a fixed set of articles per cursor so the server
// and client agree byte-for-byte during hydration.

export type Article = {
  id: string
  title: string
  excerpt: string
  body: string
  author: string
  publishedAt: string // ISO date
  readingTime: number // minutes
  topic: string
}

export type Page = {
  items: Article[]
  nextCursor: number | null
}

export type Comment = {
  id: string
  articleId: string
  author: string
  body: string
  ts: number
}

export type Api = {
  getPage(cursor: number, signal?: AbortSignal): Promise<Page>
  /**
   * Async server-side validation for a comment body. Returns `null` if OK,
   * or a human-readable error string. Exists to demo `debouncedValidator`
   * inside the comment composer's form.
   */
  validateCommentBody(body: string, signal?: AbortSignal): Promise<string | null>
  /** Submit a comment to an article — used by the composer's mutation. */
  postComment(input: Omit<Comment, 'id' | 'ts'>, signal?: AbortSignal): Promise<Comment>
  /** Recent comments for an article — feeds the composer's "current thread" view. */
  listComments(articleId: string, signal?: AbortSignal): Promise<Comment[]>
  /** Test hook — total calls. */
  callCount: number
}

const TOTAL_PAGES = 5
const PER_PAGE = 4

const TITLES = [
  'The slow web is winning',
  'On craftsmanship in software',
  'Why your tools shape what you build',
  'A short defense of long forms',
  'Reading as resistance',
  'The shape of attention',
  'Mistaking signal for noise',
  'Quiet code',
  'When less is more, exactly',
  'How rituals replace rules',
  'The third reader',
  'On finishing things',
  'Edits across a decade',
  'What we lose to autocomplete',
  'Type systems as documentation',
  'Why I keep paper notes',
  'The art of the small commit',
  'How taste accumulates',
  'On reading the manual',
  'The grammar of interfaces',
]

const TOPICS = ['design', 'engineering', 'craft', 'attention', 'tools', 'reading']
const AUTHORS = ['Stein', 'Pollan', 'Foer', 'Solnit', 'Pinker', 'Klein', 'Saunders', 'Heller']

function makeArticle(idx: number): Article {
  const id = `a${idx}`
  const title = TITLES[idx % TITLES.length]!
  return {
    id,
    title,
    excerpt: makeExcerpt(idx, title),
    body: makeBody(idx, title),
    author: AUTHORS[idx % AUTHORS.length]!,
    publishedAt: makeDate(idx),
    readingTime: ((idx * 7) % 11) + 3,
    topic: TOPICS[idx % TOPICS.length]!,
  }
}

function makeExcerpt(idx: number, title: string): string {
  const seed = (idx * 13) % 5
  const samples = [
    `A short essay on ${title.toLowerCase()} — what it means, who it costs, and why we keep coming back to it.`,
    `Notes from a long argument with myself about ${title.toLowerCase()}, with a small concession at the end.`,
    `Why the obvious answer to ${title.toLowerCase()} is also the wrong one, in three short scenes.`,
    `An attempt to defend ${title.toLowerCase()} without sounding nostalgic.`,
    `What happens when ${title.toLowerCase()} is taken too seriously, and what we lose if it isn't.`,
  ]
  return samples[seed]!
}

function makeBody(idx: number, title: string): string {
  return [
    `Some thoughts on ${title.toLowerCase()}.`,
    `It's tempting to read every essay on a screen the way you read a magazine in a waiting room — flipping until something catches your eye. But the medium teaches you to skim, and skimming teaches you to mistake the surface for the substance.`,
    `Article number ${idx} in this series. Each entry is generated deterministically so the server and the client produce the same bytes during hydration. The text is filler; the SSR contract is real.`,
    `The remainder of this essay is left as an exercise to the reader's imagination.`,
  ].join('\n\n')
}

function makeDate(idx: number): string {
  // Deterministic: walk backward from a fixed date.
  const base = new Date('2026-05-18T00:00:00Z').getTime()
  const stride = 86400 * 1000 * 3 // every 3 days
  const t = base - idx * stride
  return new Date(t).toISOString().slice(0, 10)
}

const BANNED = ['spam', 'lorem', 'click here']

let commentIdSeq = 1
const commentsByArticle = new Map<string, Comment[]>()

export function createFakeApi(): Api {
  const api: Api = {
    callCount: 0,

    async getPage(cursor: number, signal?: AbortSignal) {
      api.callCount += 1
      await delay(5, signal)
      const start = cursor * PER_PAGE
      const items = Array.from({ length: PER_PAGE }, (_, i) => makeArticle(start + i))
      const nextCursor = cursor + 1 < TOTAL_PAGES ? cursor + 1 : null
      return { items, nextCursor }
    },

    async validateCommentBody(body, signal) {
      // Simulate a network round-trip to a content-moderation service.
      // Long enough for the user to notice the `isValidating` spinner.
      await delay(180, signal)
      const trimmed = body.trim()
      if (trimmed.length < 12) return 'Comment must be at least 12 characters.'
      if (trimmed.length > 500) return 'Comment must be at most 500 characters.'
      const lower = trimmed.toLowerCase()
      for (const banned of BANNED) {
        if (lower.includes(banned)) return `“${banned}” isn't allowed.`
      }
      return null
    },

    async postComment(input, signal) {
      await delay(80, signal)
      const comment: Comment = { ...input, id: `cm${commentIdSeq++}`, ts: Date.now() }
      const list = commentsByArticle.get(input.articleId) ?? []
      commentsByArticle.set(input.articleId, [comment, ...list])
      return comment
    },

    async listComments(articleId, signal) {
      await delay(40, signal)
      return commentsByArticle.get(articleId)?.slice() ?? []
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
