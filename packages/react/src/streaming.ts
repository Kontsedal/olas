import { batch, type OlasPlugin, type Root } from '@kontsedal/olas-core'

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
  /** Present for an infinite query: the params of `data`'s pages. */
  pageParams?: readonly unknown[]
}

/**
 * Global key under which the client-side bootstrap stashes the queue of
 * incoming dehydrated entries. Exposed as a constant so consumers writing
 * custom serialization can match it.
 */
export const STREAMING_GLOBAL = '__OLAS_HYDRATION__' as const

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
export const OLAS_BOOTSTRAP_SCRIPT = `;(function(){var g=self||window;if(!g.${STREAMING_GLOBAL})g.${STREAMING_GLOBAL}={q:[],push:function(b){this.q.push(b)}};})()`

/**
 * Result of `createStreamingHydrator()`. The `plugin` field is what you
 * register on the server's root; the `flush()` method pulls any
 * server-resolved entries that haven't been flushed yet, formatted as a
 * `<script>` tag ready to interleave into the React stream.
 *
 * Typical usage with `renderToPipeableStream`:
 *
 * ```ts
 * const { plugin, flush, dispose } = createStreamingHydrator()
 * const root = createRoot(appDef, { deps, plugins: [plugin] })
 *
 * const { pipe } = renderToPipeableStream(
 *   <OlasProvider root={root}><App /></OlasProvider>,
 *   {
 *     bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT,
 *     onShellReady() {
 *       res.setHeader('Content-Type', 'text/html')
 *       pipe(res)
 *     },
 *     onAllReady() {
 *       res.write(flush())  // any entries that resolved post-shell
 *       dispose()
 *     },
 *   },
 * )
 * ```
 *
 * Or interleave per-boundary with a `Transform` stream that calls
 * `flush()` between React's chunk writes. Either approach delivers the
 * same property: every server-resolved entry reaches the client before the
 * corresponding hydration boundary commits.
 */
export type StreamingHydrator = {
  /** Register on the server root's `RootOptions.plugins`. */
  plugin: OlasPlugin
  /**
   * Drain pending entries as a single `<script>` tag string. Returns the
   * empty string when nothing's pending. Safe to call repeatedly —
   * already-flushed entries are not re-emitted.
   */
  flush(): string
  /** Drop captured state. Call after the stream closes. */
  dispose(): void
}

/**
 * Server-side hydrator. Captures every committed write — a fetch resolving, a
 * canonical `write` or `replace` — through the plugin `onWrite` hook, then
 * serializes captured entries to inline `<script>` tags via `flush()`. An
 * infinite query's entry carries its pages and their `pageParams`, so the
 * client continues paging from where the server stopped.
 *
 * Hydration and optimistic writes are not captured: the first is data the
 * client already has, and the second is a guess the server never confirmed.
 */
export function createStreamingHydrator(): StreamingHydrator {
  const pending: StreamingEntry[] = []
  const seen = new Map<string, number>()

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
      let serialized: string
      try {
        serialized = JSON.stringify(batch)
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
        serialized = JSON.stringify(safe)
      }
      // XSS-safe — strip `<` so a `data` containing `</script>` can't break
      // out of the tag. JSON.stringify already escapes quotes / control
      // chars; the remaining hazard is the literal `</` sequence.
      const json = serialized.replace(/</g, '\\u003c')
      return `<script>(self.${STREAMING_GLOBAL}=self.${STREAMING_GLOBAL}||{q:[],push:function(b){this.q.push(b)}}).push(${json})</script>`
    },
    dispose() {
      pending.length = 0
      seen.clear()
    },
  }
}

/**
 * Web-Streams transformer that auto-interleaves `flush()` output between
 * upstream chunks. Wraps `renderToReadableStream` (or any other
 * `ReadableStream<Uint8Array>` producing HTML) so each chunk React
 * writes is followed by a `<script>` tag carrying every entry that
 * resolved since the previous chunk.
 *
 * Works in Node 18+, the Edge runtime, Cloudflare Workers, Deno, and
 * the browser — anywhere Web Streams are available.
 *
 * ```tsx
 * const { plugin, flush } = createStreamingHydrator()
 *
 * // Attach the streaming plugin to the SAME root that renders by passing it
 * // through HydrationBoundary's options — do NOT create a separate root, or
 * // the plugin sits on a root nothing renders and no entries are captured.
 * const stream = await renderToReadableStream(
 *   <HydrationBoundary def={appDef} options={{ deps, plugins: [plugin] }}>
 *     <App />
 *   </HydrationBoundary>,
 *   { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT },
 * )
 * const interleaved = stream.pipeThrough(createStreamingTransform(flush))
 * return new Response(interleaved, { headers: { 'content-type': 'text/html' } })
 * ```
 *
 * For Node's callback-style `renderToPipeableStream`, write a tiny
 * `Transform` that calls `flush()` after every `transform(chunk, ..., cb)`
 * — same shape, different stream API.
 *
 * The transformer drains one final time on flush so any entries that
 * settled between the last chunk and stream close still reach the
 * client.
 */
export function createStreamingTransform(
  flush: () => string,
): TransformStream<Uint8Array, Uint8Array> {
  // Use a single TextEncoder for the lifetime of the stream — cheaper
  // than allocating per chunk for high-volume responses.
  const encoder = new TextEncoder()
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
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
