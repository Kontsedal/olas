import { batch, type OlasPlugin, type Root, serializeForScript } from '@kontsedal/olas-core'

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
 * The intake is a tiny "push-only array" — entries land here until a
 * `<HydrationBoundary>` mounts and drains them. Subsequent pushes after
 * drain go directly through the boundary's installed forwarder.
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
 * chunks, so a chunk boundary can fall inside a tag or an attribute value.
 * A `<script>` written there breaks the markup, and the payload's quotes can
 * close the attribute. Let `createStreamingTransform` place the tags: it
 * writes one only where the HTML so far sits between elements. With Node's
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
 * canonical `write` or `replace` — through the plugin `onWrite` hook, then
 * serializes captured entries to inline `<script>` tags via `flush()`. An
 * infinite query's entry carries its pages and their `pageParams`, so the
 * client continues paging from where the server stopped.
 *
 * Hydration and optimistic writes are not captured: the first is data the
 * client already has, and the second is a guess the server never confirmed.
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
            if (source !== 'fetch' && source !== 'write' && source !== 'replace') return
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
 * A minimal HTML tokenizer over the stream, enough to know whether the output
 * so far ends between elements. React's HTML is well-formed and double-quotes
 * every attribute value, so five states cover it: text, a tag (with its
 * quoted attribute values), a comment or doctype, and the content of an
 * opaque element.
 */
export class HtmlBoundary {
  private state: 'text' | 'open' | 'tag' | 'quote' | 'squote' | 'bang' | 'comment' | 'opaque' =
    'text'
  private tagName = ''
  private readingName = false
  private closing = false
  /** Recent characters, for `<!--`, `-->` and an opaque element's end tag. */
  private window = ''
  private opaqueEnd = ''

  /** Advance over `text`. */
  feed(text: string): void {
    for (const ch of text) this.step(ch)
  }

  /** True when the output so far ends between elements, where a tag can go. */
  get atBoundary(): boolean {
    return this.state === 'text'
  }

  private step(ch: string): void {
    switch (this.state) {
      case 'text':
        if (ch === '<') this.state = 'open'
        return
      case 'open':
        if (ch === '!') {
          this.state = 'bang'
          this.window = ''
        } else if (ch === '/') {
          this.enterTag(true)
        } else if (/[a-zA-Z]/.test(ch)) {
          this.enterTag(false)
          this.tagName = ch.toLowerCase()
        } else {
          // A `<` that starts no tag is text. React escapes a literal one.
          this.state = 'text'
        }
        return
      case 'tag':
        if (this.readingName) {
          if (/[a-zA-Z0-9-]/.test(ch)) {
            this.tagName += ch.toLowerCase()
            return
          }
          this.readingName = false
        }
        if (ch === '"') this.state = 'quote'
        else if (ch === "'") this.state = 'squote'
        else if (ch === '>') this.closeTag()
        return
      case 'quote':
        if (ch === '"') this.state = 'tag'
        return
      case 'squote':
        if (ch === "'") this.state = 'tag'
        return
      case 'bang':
        this.window += ch
        if (this.window === '--') {
          this.state = 'comment'
          this.window = ''
        } else if (ch === '>') {
          this.state = 'text' // a doctype
        }
        return
      case 'comment':
        this.window = (this.window + ch).slice(-3)
        if (this.window === '-->') this.state = 'text'
        return
      case 'opaque':
        this.window = (this.window + ch.toLowerCase()).slice(-this.opaqueEnd.length)
        if (this.window === this.opaqueEnd) {
          // The rest of the end tag, up to its `>`.
          this.state = 'tag'
          this.closing = true
          this.readingName = false
          this.tagName = ''
        }
        return
    }
  }

  private enterTag(closing: boolean): void {
    this.state = 'tag'
    this.closing = closing
    this.readingName = !closing
    this.tagName = ''
  }

  private closeTag(): void {
    if (!this.closing && OPAQUE.has(this.tagName)) {
      this.state = 'opaque'
      this.opaqueEnd = `</${this.tagName}`
      this.window = ''
    } else {
      this.state = 'text'
    }
  }
}

/**
 * Web-Streams transformer that interleaves `flush()` output into an HTML
 * stream. Wraps `renderToReadableStream` (or any other
 * `ReadableStream<Uint8Array>` producing HTML), so each batch of entries that
 * resolved reaches the client as the stream goes.
 *
 * A batch is written only where the HTML so far sits between elements. React
 * writes in fixed-size chunks, and a chunk can end inside a tag or an
 * attribute value; a `<script>` written there breaks the markup, and the
 * payload's quotes can close the attribute and inject new ones. The transform
 * tracks the markup it passes through (`HtmlBoundary`) and holds a batch until
 * a chunk ends at a boundary. Entries keep collecting in the hydrator
 * meanwhile, so the held batch goes out whole.
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
 * after the last chunk still reach the client.
 */
export function createStreamingTransform(
  flush: () => string,
): TransformStream<Uint8Array, Uint8Array> {
  // Use a single TextEncoder for the lifetime of the stream — cheaper
  // than allocating per chunk for high-volume responses.
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const boundary = new HtmlBoundary()
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      boundary.feed(decoder.decode(chunk, { stream: true }))
      if (!boundary.atBoundary) return
      const pending = flush()
      if (pending.length > 0) controller.enqueue(encoder.encode(pending))
    },
    flush(controller) {
      // Stream closing — drain any entries that settled in the window
      // between the last upstream chunk and `close()`. Without this,
      // the very last batch of resolved boundaries would be lost on
      // streams that don't write a trailing chunk after the final
      // settle.
      const pending = flush()
      if (pending.length > 0) controller.enqueue(encoder.encode(pending))
    },
  })
}

/**
 * Connect a live root to the streamed hydration entries. Called from
 * `HydrationBoundary` on mount. The root first receives every batch that has
 * already arrived, then each new batch as the stream delivers it. Several
 * roots can be installed at once. Returns the uninstall function.
 *
 * Exposed so consumers writing custom Provider shells can wire up the
 * stream without reaching through `<HydrationBoundary>`.
 */
export function installStreamingIntake<Api>(root: Root<Api>): () => void {
  const g = (typeof self !== 'undefined' ? self : (globalThis as unknown)) as Record<
    string,
    unknown
  >
  type Entry = StreamingEntry
  type Sink = (entries: Entry[]) => void
  type Intake = { q: Entry[][]; push: (entries: Entry[]) => void; sinks?: Set<Sink> }
  const toState = (entries: Entry[]) => ({
    version: 1 as const,
    entries: entries.map((e) => ({
      id: e.queryId,
      key: e.key,
      data: e.data,
      lastUpdatedAt: e.lastUpdatedAt,
      ...(e.pageParams !== undefined ? { pageParams: e.pageParams } : {}),
    })),
  })
  // Apply every entry of one stream batch in a single signal `batch(...)`, so
  // subscribers see ONE notification per batch instead of one per entry.
  const apply: Sink = (entries) => {
    batch(() => root.hydrate(toState(entries)))
  }

  // Upgrade the bootstrap queue — or nothing, when the bootstrap script did
  // not run — into a fan-out intake. It keeps every batch it has seen and
  // delivers each new one to every installed root. So a second boundary, or a
  // StrictMode remount's fresh root, catches up on the stream so far instead
  // of taking the intake away from the first.
  let intake = g[STREAMING_GLOBAL] as Intake | undefined
  if (intake?.sinks === undefined) {
    const q = intake !== undefined && Array.isArray(intake.q) ? intake.q : []
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
  const sinks = intake.sinks as Set<Sink>
  batch(() => {
    for (const entries of intake.q) root.hydrate(toState(entries))
  })
  sinks.add(apply)
  return () => {
    // Later batches keep queueing on the intake for whatever root installs next.
    sinks.delete(apply)
  }
}
