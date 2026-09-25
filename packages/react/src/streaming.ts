import {
  batch,
  type DehydratedEntry,
  type DehydratedState,
  type OlasPlugin,
  type Root,
  serializeForScript,
} from '@kontsedal/olas-core'

/**
 * Wire format for a single streamed entry. Distinct from
 * `DehydratedEntry` (which is keyed by hash) — streaming routes by
 * `queryId` so the client can look up the registered query without
 * re-hashing on every push.
 */
type StreamingEntry = {
  queryId: string
  key: readonly unknown[]
  data: unknown
  lastUpdatedAt: number
  /**
   * Present for an infinite query: the params of `data`'s pages.
   */
  pageParams?: readonly unknown[]
}

/**
 * Global key under which the client-side bootstrap stashes the queue of
 * incoming dehydrated entries. Exposed as a constant so consumers writing
 * custom serialization can match it.
 */
export const STREAMING_GLOBAL = '__OLAS_HYDRATION__' as const

/**
 * The global is an intake only when it has a `push` function and a `q` array.
 * Anything else there, such as a DOM element with that `id` reached through
 * the window's named access, is replaced rather than trusted.
 */
const INTAKE_CHECK = `var i=g.${STREAMING_GLOBAL};if(!(i&&typeof i.push==='function'&&Array.isArray(i.q)))g.${STREAMING_GLOBAL}={q:[],push:function(b){this.q.push(b)}};`

/**
 * Bootstrap script that primes the client's intake queue *before* React's
 * hydration runs. Drop the string into `renderToPipeableStream`'s
 * `bootstrapScriptContent` (or `bootstrapScripts` / a manual `<script>`):
 *
 * ```ts
 * renderToPipeableStream(<App />, {
 *   bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT,
 *   onShellReady() { ... },
 * })
 * ```
 *
 * The intake is a tiny "push-only array". Batches land here, and a
 * `<HydrationBoundary>` folds the ones already there into the root it builds.
 * Once it commits, later pushes go through the forwarder it installs.
 */
export const OLAS_BOOTSTRAP_SCRIPT = `;(function(){var g=self||window;${INTAKE_CHECK}})()`

/** Options for `createStreamingHydrator`. */
export type StreamingHydratorOptions = {
  /**
   * A Content-Security-Policy nonce for the `<script>` tags `flush()` emits.
   * Under a `script-src 'nonce-…'` policy the browser blocks an inline script
   * without it. Pass the same nonce to React's `renderToReadableStream` /
   * `renderToPipeableStream` for its own scripts.
   */
  nonce?: string
}

/**
 * Result of `createStreamingHydrator()`. The `plugin` field is what you
 * register on the server's root; the `flush()` method pulls any
 * server-resolved entries that haven't been flushed yet, formatted as a
 * `<script>` tag.
 *
 * **Where the tag goes matters.** React writes its stream in fixed-size
 * chunks, so a chunk boundary can fall inside a tag, an attribute value or a
 * text node. A `<script>` written there breaks the markup, the payload's
 * quotes can close the attribute, and one inside an element React hydrates
 * breaks hydration. Let `createStreamingTransform` place the tags: it writes
 * one only where React's hydration never sees it. With Node's
 * `renderToPipeableStream`, render with `renderToReadableStream` instead
 * (Node has Web Streams) and pipe through the transform, or write
 * `flush()` yourself only after the stream has ended.
 *
 * ```tsx
 * const { plugin, flush, dispose } = createStreamingHydrator({ nonce })
 * const root = createRoot(appDef, { deps, queries: queryEngine(), plugins: [plugin] })
 * const stream = await renderToReadableStream(
 *   <OlasProvider root={root}>
 *     <App />
 *   </OlasProvider>,
 *   { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT, nonce },
 * )
 * return new Response(stream.pipeThrough(createStreamingTransform(flush)))
 * // Once the response has finished: root.dispose(), then dispose().
 * ```
 */
export type StreamingHydrator = {
  /**
   * Register on the server root's `RootOptions.plugins`.
   */
  plugin: OlasPlugin
  /**
   * Drain pending entries as a single `<script>` tag string. Returns the
   * empty string when nothing's pending. Safe to call repeatedly —
   * already-flushed entries are not re-emitted.
   */
  flush(): string
  /**
   * Drop captured state. Call after the stream closes.
   */
  dispose(): void
}

/** An attribute value, escaped for a double-quoted attribute. */
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Server-side hydrator. Captures every committed write — a fetch resolving, a
 * canonical `write` or `replace`, an optimistic layer committed as server
 * truth — through the plugin `onWrite` hook, then serializes captured entries
 * to inline `<script>` tags via `flush()`. An infinite query's entry carries
 * its pages and their `pageParams`, so the client continues paging from where
 * the server stopped.
 *
 * Hydration, optimistic writes and rollbacks are not captured: the first is
 * data the client already has, and the other two are a guess the server never
 * confirmed and its undoing. A `'commit'` is captured, because it is the data
 * the server rendered once no guess is left.
 *
 * The payload is serialized with `serializeForScript`: `JSON.parse` over a
 * fully escaped string, so query data cannot end the script, form markup, or
 * turn a `__proto__` key into a prototype on the client.
 */
export function createStreamingHydrator(options: StreamingHydratorOptions = {}): StreamingHydrator {
  const pending: StreamingEntry[] = []
  const seen = new Map<string, number>()
  const open =
    options.nonce === undefined ? '<script>' : `<script nonce="${escapeAttribute(options.nonce)}">`

  return {
    plugin: {
      name: 'olas-streaming-hydrator',
      setup(host) {
        return {
          onWrite(event) {
            const { source } = event
            if (
              source !== 'fetch' &&
              source !== 'write' &&
              source !== 'replace' &&
              source !== 'commit'
            ) {
              return
            }
            // Dedupe by (query id, key hash) — most recent value wins. A
            // refetch-after-mutate would emit twice; we want to ship only the
            // latest.
            const hash = host.queries?.hashKey(event.key) ?? JSON.stringify(event.key)
            const dedupeKey = `${event.query.id} ${hash}`
            const entry: StreamingEntry = {
              queryId: event.query.id,
              key: event.key,
              data: event.data,
              lastUpdatedAt: event.updatedAt,
              ...(event.pageParams !== undefined ? { pageParams: event.pageParams } : {}),
            }
            const lastEmittedIdx = seen.get(dedupeKey)
            if (lastEmittedIdx !== undefined) {
              pending[lastEmittedIdx] = entry
              return
            }
            seen.set(dedupeKey, pending.length)
            pending.push(entry)
          },
        }
      },
    },
    flush() {
      if (pending.length === 0) return ''
      const batch = pending.splice(0)
      seen.clear()
      let payload: string
      try {
        payload = serializeForScript(batch)
      } catch {
        // One entry carries an un-serializable payload (a BigInt, a circular
        // ref, …). Drop the offending entries and keep the rest so a single bad
        // payload can't throw out of flush() and corrupt the whole stream
        // chunk (T3.9). Server-side, so an unconditional warn is fine.
        const safe = batch.filter((entry) => {
          try {
            JSON.stringify(entry)
            return true
          } catch (err) {
            console.warn('[olas] streaming SSR: skipped an un-serializable hydration entry', err)
            return false
          }
        })
        if (safe.length === 0) return ''
        payload = serializeForScript(safe)
      }
      return `${open}(function(){var g=self;${INTAKE_CHECK}g.${STREAMING_GLOBAL}.push(${payload})})()</script>`
    },
    dispose() {
      pending.length = 0
      seen.clear()
    },
  }
}

/**
 * Elements whose content is not parsed as markup (raw text and RCDATA), plus
 * `template`, whose content never runs. A `<script>` written inside any of
 * them would break the content or never execute.
 */
const OPAQUE = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'template',
  'noscript',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
])

/**
 * The comments React opens a `<Suspense>` or `<Activity>` boundary with, and
 * the ones it closes them with. Everything between is hydrated as the
 * boundary's content.
 */
const REGION_START = new Set(['$', '$?', '$!', '$~', '&'])
const REGION_END: Record<string, string> = { '/$': '$', '/&': '&' }

const LT = 0x3c
const GT = 0x3e
const SLASH = 0x2f
const BANG = 0x21
const QUESTION = 0x3f
const DQUOTE = 0x22
const SQUOTE = 0x27

const TEXT = 0
const OPEN = 1
const TAG = 2
const QUOTE = 3
const APOS = 4
const BANG_OPEN = 5
const COMMENT = 6
const RAW = 7

const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
const isNameChar = (c: number): boolean =>
  isAlpha(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x3a
const isSpace = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d
const lower = (c: number): string => String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 0x20 : c)

/**
 * A minimal HTML tokenizer over the stream, enough to know where a `<script>`
 * can go without React's hydration ever seeing it.
 *
 * React hydrates every element it rendered, and a stray element inside one is
 * a mismatch. It skips one only in the root container and in the `<html>` and
 * `<body>` singletons. The content between a `<Suspense>` boundary's comments
 * is hydrated too, and so is a completed segment, `<div hidden id="S:0">…`,
 * because React's reveal moves its children into the boundary. So a batch may
 * go only where no element other than `html` and `body` is open, outside every
 * boundary's comments, and right after a tag or a comment ends. Right after,
 * because a text node there might go on in the next chunk.
 *
 * React's HTML is well-formed and double-quotes every attribute value, so a
 * few states cover it: text, a tag with its quoted attribute values, a comment
 * or doctype, and the content of an opaque element. It reads bytes: UTF-8
 * never uses a byte below 0x80 inside a multi-byte character, and every byte
 * it acts on is ASCII.
 */
export type HtmlBoundary = {
  /** Advance over `text`. */
  feed(text: string): void
  /**
   * Advance over `chunk`. Returns the first offset in it, from 0 to its
   * length, where a batch can go, or -1 when there is none.
   */
  scan(chunk: Uint8Array): number
  /**
   * True when a `<script>` can go here mid-stream: right after a tag or a
   * comment, outside every element React hydrates and every boundary region.
   * In a whole document that means directly inside `<body>`; in a fragment,
   * at the top level, the container React hydrates into.
   */
  readonly canInsert: boolean
  /**
   * True when a `<script>` can go at the end of the stream: outside every
   * tag, comment, raw text, hydrated element and boundary region. Nothing
   * follows, so the end of a text node is safe here, and so is the end of a
   * document, where the parser moves the script into `<body>`.
   */
  readonly canClose: boolean
}

/** A fresh `HtmlBoundary`, at the start of a stream. */
export function htmlBoundary(): HtmlBoundary {
  let state = TEXT
  /** The tag name so far, lowercased. */
  let name = ''
  let readingName = false
  let closing = false
  let selfClosing = false
  /** The end tag of a raw-text element just ended; its start tag pushed nothing. */
  let rawEnd = false
  /** Recent characters, for `<!--`, `-->`, a doctype and an opaque element's end tag. */
  let recent = ''
  /** The first characters of the current comment, for React's boundary markers. */
  let comment = ''
  let opaqueEnd = ''
  /** Open elements and boundary regions (`$`, `&`), innermost last. */
  const open: string[] = []
  /** Entries of `open` other than `html` and `body`: what React hydrates. */
  let depth = 0
  /** Open `body` elements. */
  let bodies = 0
  /** A doctype, `html`, `head` or `body` was seen: the stream is a whole document. */
  let whole = false
  /** The last token was a tag, a comment or a doctype, not text. */
  let afterMarkup = false

  const canInsert = (): boolean =>
    state === TEXT && afterMarkup && depth === 0 && (!whole || bodies > 0)

  const push = (n: string): void => {
    open.push(n)
    if (n === 'body') bodies++
    else if (n !== 'html') depth++
  }

  /** Close `n` and everything opened inside it. An unmatched end tag changes nothing. */
  const close = (n: string): void => {
    const at = open.lastIndexOf(n)
    if (at < 0) return
    for (const removed of open.splice(at)) {
      if (removed === 'body') bodies--
      else if (removed !== 'html') depth--
    }
  }

  const enterTag = (isClosing: boolean): void => {
    state = TAG
    closing = isClosing
    readingName = true
    selfClosing = false
    name = ''
  }

  const endTag = (): void => {
    state = TEXT
    afterMarkup = true
    if (rawEnd) {
      rawEnd = false
      return
    }
    if (closing) {
      close(name)
      return
    }
    if (name === 'html' || name === 'head' || name === 'body') whole = true
    if (OPAQUE.has(name) && !selfClosing) {
      state = RAW
      opaqueEnd = `</${name}`
      recent = ''
      return
    }
    // React writes every void element as `<br/>`. One left open, as in
    // hand-written HTML, closes with its parent's end tag, so it can only hold
    // a batch back, never let one in.
    if (!selfClosing) push(name)
  }

  const endComment = (): void => {
    state = TEXT
    afterMarkup = true
    // A marker is short: the comment's data, then `-->`.
    if (comment.length >= 8) return
    const data = comment.slice(0, -3)
    if (REGION_START.has(data)) push(data === '&' ? '&' : '$')
    else if (REGION_END[data] !== undefined) close(REGION_END[data])
  }

  const step = (c: number): void => {
    switch (state) {
      case TEXT:
        if (c === LT) state = OPEN
        afterMarkup = false
        return
      case OPEN:
        if (c === BANG || c === QUESTION) {
          state = BANG_OPEN
          recent = c === QUESTION ? '?' : ''
        } else if (c === SLASH) {
          enterTag(true)
        } else if (isAlpha(c)) {
          enterTag(false)
          name = lower(c)
        } else {
          // A `<` that starts no tag is text. React escapes a literal one.
          state = TEXT
        }
        return
      case TAG:
        if (readingName) {
          if (isNameChar(c)) {
            name += lower(c)
            return
          }
          readingName = false
        }
        if (c === DQUOTE) state = QUOTE
        else if (c === SQUOTE) state = APOS
        else if (c === GT) endTag()
        else if (c === SLASH) selfClosing = true
        else if (!isSpace(c)) selfClosing = false
        return
      case QUOTE:
      case APOS:
        if (c === (state === QUOTE ? DQUOTE : SQUOTE)) {
          state = TAG
          selfClosing = false
        }
        return
      case BANG_OPEN:
        if (c === GT) {
          // A doctype, or a bogus comment such as `<?xml …>`.
          if (recent.startsWith('doctype')) whole = true
          state = TEXT
          afterMarkup = true
          return
        }
        // Only the start is ever read, so it stays short.
        if (recent.length < 8) recent += lower(c)
        if (recent === '--') {
          state = COMMENT
          recent = ''
          comment = ''
        }
        return
      case COMMENT:
        recent = (recent + String.fromCharCode(c)).slice(-3)
        if (comment.length < 8) comment += String.fromCharCode(c)
        if (recent === '-->') endComment()
        return
      default:
        // RAW: the content of an opaque element, up to its end tag.
        recent = (recent + lower(c)).slice(-opaqueEnd.length)
        if (recent === opaqueEnd) {
          // The rest of the end tag, up to its `>`. The start tag pushed nothing.
          state = TAG
          closing = true
          readingName = false
          rawEnd = true
          name = ''
        }
    }
  }

  return {
    feed(text) {
      for (let i = 0; i < text.length; i++) step(text.charCodeAt(i))
    },
    scan(chunk) {
      let first = canInsert() ? 0 : -1
      for (let i = 0; i < chunk.length; i++) {
        step(chunk[i] as number)
        if (first < 0 && canInsert()) first = i + 1
      }
      return first
    },
    get canInsert() {
      return canInsert()
    },
    get canClose() {
      return state === TEXT && depth === 0
    },
  }
}

/**
 * Web-Streams transformer that interleaves `flush()` output into an HTML
 * stream. Wraps `renderToReadableStream` (or any other
 * `ReadableStream<Uint8Array>` producing HTML), so each batch of entries that
 * resolved reaches the client as the stream goes.
 *
 * A batch goes only where React's hydration never sees it: directly inside
 * `<body>` for a whole document, or at the top level for a fragment React
 * hydrates into a container, outside every `<Suspense>` boundary's content,
 * and right after a tag or a comment. So never inside a tag, an attribute, a
 * comment, raw text or a text node, and never inside an element React
 * hydrates. React writes in fixed-size chunks, which can end anywhere, so the
 * transform tracks the markup it passes through (`htmlBoundary`). Each chunk
 * gets the pending batch at its first such point, so data goes out before the
 * markup that reads it. A chunk with no such point holds the batch; entries
 * keep collecting in the hydrator meanwhile, so the held batch goes out whole.
 *
 * Pipe React's own stream through the transform, and put any HTML template of
 * your own around its output. A template inside the transform puts the page
 * inside an element the transform cannot tell from React's, and every batch
 * waits for the end.
 *
 * Works in Node, the Edge runtime, Cloudflare Workers, Deno, and
 * the browser — anywhere Web Streams are available.
 *
 * ```tsx
 * const { plugin, flush } = createStreamingHydrator()
 *
 * // One root per request, carrying the plugin, and the SAME root renders.
 * // A plugin on a root nothing renders captures no entries. The root needs a
 * // query engine, or there is no cache to capture. On the server, render
 * // through `OlasProvider`: a `HydrationBoundary` builds its root in render
 * // and disposes it in an effect, and effects do not run on the server.
 * const root = createRoot(appDef, { deps, queries: queryEngine(), plugins: [plugin] })
 * const stream = await renderToReadableStream(
 *   <OlasProvider root={root}>
 *     <App />
 *   </OlasProvider>,
 *   { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT },
 * )
 * const interleaved = stream.pipeThrough(createStreamingTransform(flush))
 * return new Response(interleaved, { headers: { 'content-type': 'text/html' } })
 * ```
 *
 * The transformer drains one final time on close, so entries that settled
 * after the last chunk still reach the client. A stream that ends inside
 * markup gets no final batch, since no script can go there.
 */
export function createStreamingTransform(
  flush: () => string,
): TransformStream<Uint8Array, Uint8Array> {
  // Use a single TextEncoder for the lifetime of the stream — cheaper
  // than allocating per chunk for high-volume responses.
  const encoder = new TextEncoder()
  const boundary = htmlBoundary()
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const at = boundary.scan(chunk)
      const pending = at < 0 ? '' : flush()
      if (pending.length === 0) {
        controller.enqueue(chunk)
        return
      }
      if (at > 0) controller.enqueue(chunk.subarray(0, at))
      controller.enqueue(encoder.encode(pending))
      if (at < chunk.length) controller.enqueue(chunk.subarray(at))
    },
    flush(controller) {
      // Stream closing — drain any entries that settled in the window
      // between the last upstream chunk and `close()`. Without this,
      // the very last batch of resolved boundaries would be lost on
      // streams that don't write a trailing chunk after the final
      // settle.
      if (!boundary.canClose) return
      const pending = flush()
      if (pending.length > 0) controller.enqueue(encoder.encode(pending))
    },
  })
}

type Sink = (entries: StreamingEntry[]) => void
type Intake = { q: unknown[]; push: (entries: StreamingEntry[]) => void; sinks?: Set<Sink> }

const scope = (): Record<string, unknown> =>
  (typeof self !== 'undefined' ? self : (globalThis as unknown)) as Record<string, unknown>

/** The page's queue of batches, when a bootstrap or a batch script has made one. */
function currentQueue(): unknown[] | undefined {
  const intake = scope()[STREAMING_GLOBAL] as Partial<Intake> | undefined
  return intake !== undefined && intake !== null && Array.isArray(intake.q) ? intake.q : undefined
}

/**
 * One streamed batch as dehydrated rows. A batch is whatever a script pushed,
 * so anything but an array of objects is skipped here, and core checks each
 * row's shape.
 */
function rowsOf(batch: unknown): DehydratedEntry[] {
  if (!Array.isArray(batch)) return []
  const rows: DehydratedEntry[] = []
  for (const e of batch as StreamingEntry[]) {
    if (typeof e !== 'object' || e === null) continue
    rows.push({
      id: e.queryId,
      key: e.key,
      data: e.data,
      lastUpdatedAt: e.lastUpdatedAt,
      ...(e.pageParams !== undefined ? { pageParams: e.pageParams } : {}),
    } as DehydratedEntry)
  }
  return rows
}

const stateOf = (batch: unknown): DehydratedState => ({ version: 1, entries: rowsOf(batch) })

/**
 * How far a root has read the page's queue of batches: the queue it read, and
 * how many batches of it. `HydrationBoundary` keeps one per root it builds for
 * the streamed page, so a root never takes a batch twice.
 */
export type StreamCursor = { q: readonly unknown[] | null; n: number }

/**
 * Every batch the page has received so far, as rows, and a cursor past them.
 * `HydrationBoundary` puts the rows in `RootOptions.hydrate`, so they are
 * buffered before any controller binds its key: the first render reads them,
 * and no fetch starts for them.
 */
export function readStreamed(): { rows: DehydratedEntry[]; cursor: StreamCursor } {
  const q = currentQueue()
  if (q === undefined) return { rows: [], cursor: { q: null, n: 0 } }
  return { rows: q.flatMap(rowsOf), cursor: { q, n: q.length } }
}

/**
 * Apply to `root` the batches past `cursor`, in one signal `batch(...)`, and
 * move the cursor to the end. A cursor over another queue starts from the
 * first batch.
 */
export function catchUp<Api>(root: Root<Api>, cursor: StreamCursor): void {
  const q = currentQueue()
  if (q === undefined) return
  const from = cursor.q === q ? cursor.n : 0
  if (from < q.length) {
    batch(() => {
      for (let i = from; i < q.length; i++) root.hydrate(stateOf(q[i]))
    })
  }
  cursor.q = q
  cursor.n = q.length
}

/**
 * `installStreamingIntake` with a cursor: the root takes only the batches past
 * it, then each new one, and the cursor follows.
 */
export function connectIntake<Api>(root: Root<Api>, cursor: StreamCursor): () => void {
  const g = scope()
  // Upgrade the bootstrap queue — or nothing, when the bootstrap script did
  // not run — into a fan-out intake. It keeps every batch it has seen and
  // delivers each new one to every installed root. So a second boundary, or a
  // StrictMode remount's fresh root, catches up on the stream so far instead
  // of taking the intake away from the first.
  let intake = g[STREAMING_GLOBAL] as Intake | undefined
  if (intake?.sinks === undefined) {
    const q = intake !== undefined && intake !== null && Array.isArray(intake.q) ? intake.q : []
    const sinks = new Set<Sink>()
    const upgraded: Intake = {
      q,
      sinks,
      push(entries) {
        q.push(entries)
        for (const sink of sinks) sink(entries)
      },
    }
    g[STREAMING_GLOBAL] = upgraded
    intake = upgraded
  }
  const { q, sinks } = intake as Required<Intake>
  catchUp(root, cursor)
  // Apply every entry of one stream batch in a single signal `batch(...)`, so
  // subscribers see ONE notification per batch instead of one per entry.
  const apply: Sink = (entries) => {
    batch(() => root.hydrate(stateOf(entries)))
    cursor.q = q
    cursor.n = q.length
  }
  sinks.add(apply)
  return () => {
    // Later batches keep queueing on the intake for whatever root installs next.
    sinks.delete(apply)
  }
}

/**
 * Connect a live root to the streamed hydration entries. The root first
 * receives every batch that has already arrived, then each new batch as the
 * stream delivers it. Several roots can be installed at once. Returns the
 * uninstall function.
 *
 * For a root built outside `<HydrationBoundary>`, such as one a custom
 * provider shell creates. The boundary connects its own root, and folds the
 * batches already on the page into the root as it builds it.
 */
export function installStreamingIntake<Api>(root: Root<Api>): () => void {
  return connectIntake(root, { q: null, n: 0 })
}
