// The omnibox's search index, and the bounded text form every haystack uses.

import type { DebugCacheEntry, DebugEvent } from '@kontsedal/olas-core'
import { badgeLabel, eventTarget, laneOf } from './events'
import { formatPath } from './format'
import type { ControllerNode, TimelineEvent } from './store'
import { entryKey, pathKey, toSearchText } from './util'

/** What a search result points at. Groups come back in this order. */
export type SearchKind = 'controller' | 'query' | 'mutation' | 'field' | 'event'

/** One omnibox result: what to show, and the tab + row key a jump lands on. */
export type SearchHit = {
  kind: SearchKind
  label: string
  detail: string
  tab: 'tree' | 'inspector' | 'timeline'
  /** The row key in `tab`: a controller path key, a query-key hash, or `e<eventId>`. */
  key: string
  /** For a timeline hit, the lane its event is on, so a jump can un-hide it. */
  lane?: string
}

/** Every hit of one kind: the first `limit` of them, and how many matched. */
export type SearchGroup = { kind: SearchKind; hits: SearchHit[]; total: number }

/** Index diagnostics. `indexed` counts values turned into search text. */
export type SearchStats = { builds: number; indexed: number }

/** What the index is built from — the store's current state. */
export type SearchSources = {
  tree: ControllerNode
  entries: readonly DebugCacheEntry[]
  events: readonly TimelineEvent[]
}

type Doc = { hay: string; hit: SearchHit }
type NodeText = { props: unknown; debug: unknown; state: string; hay: string }
type EntryText = { data: unknown; error: unknown; status: string; id?: string; hay: string }

const KINDS: readonly SearchKind[] = ['controller', 'query', 'mutation', 'field', 'event']

const lower = (...parts: string[]): string => parts.join(' ').toLowerCase()

/** The content a search of payloads matches, per event; undefined = none. */
function searchPayload(ev: DebugEvent): unknown {
  switch (ev.type) {
    case 'controller:constructed':
      return ev.props
    case 'mutation:run':
      return ev.vars
    case 'mutation:success':
      return ev.result
    case 'mutation:error':
    case 'cache:fetch-error':
      return ev.error
    case 'cache:set-data':
      return ev.data
    case 'plugin:event':
      return ev.payload
    default:
      return undefined
  }
}

/**
 * The omnibox index. It is built lazily, on the first search after the store
 * changed, and each item's search text is cached, so a rebuild only turns
 * NEW or CHANGED values into text. A keystroke with no change in between
 * reuses the built index and costs one substring scan per document.
 */
export class SearchIndex {
  readonly stats: SearchStats = { builds: 0, indexed: 0 }
  private docs: Doc[][] = []
  private builtRev = -1
  private nodeText = new Map<string, NodeText>()
  private entryText = new Map<string, EntryText>()
  /** Keyed by the event object, so an event dropped from the ring drops its text too. */
  private readonly eventText = new WeakMap<TimelineEvent, Doc | null>()

  /**
   * Every document whose text contains all the whitespace-separated terms of
   * `query`, case-insensitively, grouped by kind. `rev` is the store's change
   * counter; the index rebuilds only when it moved.
   */
  search(query: string, rev: number, sources: () => SearchSources, limit = 8): SearchGroup[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    if (rev !== this.builtRev) {
      this.build(sources())
      this.builtRev = rev
    }
    const groups: SearchGroup[] = []
    this.docs.forEach((docs, i) => {
      const hits: SearchHit[] = []
      let total = 0
      for (const d of docs) {
        if (!terms.every((t) => d.hay.includes(t))) continue
        total++
        if (hits.length < limit) hits.push(d.hit)
      }
      if (total > 0) groups.push({ kind: KINDS[i] as SearchKind, hits, total })
    })
    return groups
  }

  private build(src: SearchSources): void {
    this.stats.builds++
    const controllers: Doc[] = []
    const nodeText = new Map<string, NodeText>()
    const walk = (node: ControllerNode): void => {
      for (const c of node.children) {
        const key = pathKey(c.path)
        let t = this.nodeText.get(key)
        if (t === undefined || t.props !== c.props || t.debug !== c.debug || t.state !== c.state) {
          this.stats.indexed++
          const vars = c.debug ? Object.keys(c.debug).join(' ') : ''
          t = {
            props: c.props,
            debug: c.debug,
            state: c.state,
            hay: lower(formatPath(c.path), c.state, toSearchText(c.props), vars),
          }
        }
        nodeText.set(key, t)
        const label = c.path[c.path.length - 1] ?? ''
        const hit: SearchHit = {
          kind: 'controller',
          label,
          detail: formatPath(c.path),
          tab: 'tree',
          key,
        }
        controllers.push({ hay: t.hay, hit })
        walk(c)
      }
    }
    walk(src.tree)
    this.nodeText = nodeText

    const queries: Doc[] = []
    const entryText = new Map<string, EntryText>()
    for (const e of src.entries) {
      const key = entryKey(e.queryId, e.key)
      const id = e.queryId
      let t = this.entryText.get(key)
      if (
        t === undefined ||
        t.data !== e.data ||
        t.error !== e.error ||
        t.status !== e.status ||
        t.id !== id
      ) {
        this.stats.indexed++
        const content = toSearchText(e.error ?? e.data)
        t = {
          data: e.data,
          error: e.error,
          status: e.status,
          ...(id !== undefined ? { id } : {}),
          hay: lower(id ?? '', formatPath(e.key), toSearchText(e.key), e.status, content),
        }
      }
      entryText.set(key, t)
      const path = formatPath(e.key)
      const label = id !== undefined ? `${id} · ${path}` : path
      queries.push({
        hay: t.hay,
        hit: { kind: 'query', label, detail: e.status, tab: 'inspector', key },
      })
    }
    this.entryText = entryText

    // Newest first: the first mutation or field seen is its latest run.
    const mutations = new Map<string, Doc>()
    const fields = new Map<string, Doc>()
    const events: Doc[] = []
    for (let i = src.events.length - 1; i >= 0; i--) {
      const te = src.events[i] as TimelineEvent
      const ev = te.event
      const key = `e${te.id}`
      const lane = laneOf(ev)
      const at = { tab: 'timeline' as const, key, lane }
      if (ev.type.startsWith('mutation:')) {
        const m = ev as Extract<DebugEvent, { type: 'mutation:run' }>
        const id = `${pathKey(m.path)}#${m.id ?? ''}`
        if (!mutations.has(id)) {
          const label = m.id ?? '(no id)'
          const detail = formatPath(m.path)
          mutations.set(id, {
            hay: lower(label, detail),
            hit: { kind: 'mutation', label, detail, ...at },
          })
        }
      } else if (ev.type === 'field:validated') {
        const id = `${pathKey(ev.path)}#${ev.field}`
        if (!fields.has(id)) {
          const detail = formatPath(ev.path)
          const hay = lower(ev.field, detail, ...ev.errors)
          fields.set(id, { hay, hit: { kind: 'field', label: ev.field, detail, ...at } })
        }
      }
      let doc = this.eventText.get(te)
      if (doc === undefined) {
        const payload = searchPayload(ev)
        doc = null
        if (payload !== undefined || ev.type === 'plugin:event') {
          this.stats.indexed++
          const text = toSearchText(payload)
          const plugin = ev.type === 'plugin:event' ? ev.plugin : ''
          const label = plugin || `${badgeLabel(ev)} · ${eventTarget(ev)}`
          doc = {
            hay: lower(plugin, text),
            hit: { kind: 'event', label, detail: text.slice(0, 80), ...at },
          }
        }
        this.eventText.set(te, doc)
      }
      if (doc !== null) events.push(doc)
    }
    this.docs = [controllers, queries, [...mutations.values()], [...fields.values()], events]
  }
}
