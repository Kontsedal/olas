// Fake "issues" API — generates a large in-memory dataset synchronously and
// exposes a tiny mutation surface for the demo. No real network involved; a
// fixed latency makes the demo feel honest.

export type Status = 'todo' | 'in_progress' | 'review' | 'done'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

export type Issue = {
  id: string
  title: string
  status: Status
  priority: Priority
  assignee: string
  updatedAt: number
}

export type Api = {
  generateIssues(n: number): readonly Issue[]
  saveStatus(id: string, status: Status, signal?: AbortSignal): Promise<void>
  /** Test hook — make the next write fail (one-shot). */
  failNextWrite: boolean
  setLatency(ms: number): void
}

const STATUSES: readonly Status[] = ['todo', 'in_progress', 'review', 'done']
const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low']
const ASSIGNEES = [
  'Ada',
  'Bohdan',
  'Cleo',
  'Dani',
  'Esme',
  'Finn',
  'Greta',
  'Hugo',
  'Ivy',
  'Jules',
  'Kai',
  'Lior',
  'Mira',
  'Nori',
  'Owen',
  'Priya',
] as const
const TITLE_VERBS = [
  'Investigate',
  'Refactor',
  'Migrate',
  'Document',
  'Benchmark',
  'Stabilize',
  'Audit',
  'Trim',
  'Wire',
  'Extract',
  'Annotate',
  'Cache',
  'Defer',
  'Compose',
] as const
const TITLE_NOUNS = [
  'auth flow',
  'cache eviction',
  'feed scroller',
  'icon pipeline',
  'role guard',
  'storage adapter',
  'env loader',
  'retry policy',
  'edge router',
  'usage meter',
  'image worker',
  'date parser',
  'shard balancer',
  'lint rules',
  'CI matrix',
] as const

// LCG so generation is reproducible across reloads — easier to compare runs.
const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => {
  const ix = Math.floor(rng() * arr.length)
  return arr[ix] as T
}

export function createFakeApi(): Api {
  let latency = 120

  const api: Api = {
    failNextWrite: false,
    setLatency(ms) {
      latency = ms
    },
    generateIssues(n) {
      const rng = mulberry32(424242)
      const out: Issue[] = new Array(n)
      const now = Date.now()
      for (let i = 0; i < n; i++) {
        out[i] = {
          id: `i${i.toString().padStart(6, '0')}`,
          title: `${pick(rng, TITLE_VERBS)} the ${pick(rng, TITLE_NOUNS)}`,
          status: pick(rng, STATUSES),
          priority: pick(rng, PRIORITIES),
          assignee: pick(rng, ASSIGNEES),
          updatedAt: now - Math.floor(rng() * 30 * 24 * 3_600_000),
        }
      }
      return out
    },
    async saveStatus(_id, _status, signal) {
      await delay(latency, signal)
      if (api.failNextWrite) {
        api.failNextWrite = false
        throw new Error('saveStatus failed (simulated)')
      }
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
