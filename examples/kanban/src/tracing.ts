/**
 * A tracing plugin: one span per fetch attempt and per mutate attempt, from
 * the `wrapFetch` / `wrapMutate` middleware. It shows the three shapes a
 * plugin can take at once:
 *
 *  - middleware — it times the inner chain and sees how the attempt ended;
 *  - a service — it `provide`s the `Traces` scope, so any controller can
 *    `ctx.inject(Traces)` and read the recent spans;
 *  - an `onDispose` teardown.
 *
 * Swap `onSpan` for an OpenTelemetry exporter in a real app.
 */

import { defineScope, type OlasPlugin, type ReadSignal, signal } from '@kontsedal/olas-core'

export type Span = {
  kind: 'fetch' | 'mutate'
  /** Query or mutation id; `'(anonymous)'` for an inline mutation without one. */
  name: string
  attempt: number
  startedAt: number
  durationMs: number
  outcome: 'ok' | 'error' | 'aborted'
}

export type TraceService = {
  /** The most recent spans, newest last, at most `capacity` of them. */
  readonly spans: ReadSignal<readonly Span[]>
}

export const Traces = defineScope<TraceService>({ name: 'Traces' })

export function tracingPlugin(
  options: { capacity?: number; onSpan?: (span: Span) => void } = {},
): OlasPlugin {
  const capacity = options.capacity ?? 100
  return {
    name: 'kanban-tracing',
    setup(host) {
      const spans = signal<readonly Span[]>([])
      host.provide(Traces, { spans })
      host.onDispose(() => spans.set([]))

      const time = async (
        kind: Span['kind'],
        name: string,
        attempt: number,
        signal: AbortSignal,
        next: () => Promise<unknown>,
      ): Promise<unknown> => {
        const startedAt = Date.now()
        const end = (outcome: Span['outcome']): void => {
          const span: Span = {
            kind,
            name,
            attempt,
            startedAt,
            durationMs: Date.now() - startedAt,
            outcome,
          }
          const list = spans.peek()
          spans.set(list.length >= capacity ? [...list.slice(1), span] : [...list, span])
          options.onSpan?.(span)
        }
        try {
          const value = await next()
          end('ok')
          return value
        } catch (error) {
          end(signal.aborted ? 'aborted' : 'error')
          throw error
        }
      }

      return {
        wrapFetch: (ctx, next) => time('fetch', ctx.query.id, ctx.attempt, ctx.signal, next),
        wrapMutate: (ctx, next) =>
          time('mutate', ctx.mutation.id ?? '(anonymous)', ctx.attempt, ctx.signal, next),
      }
    },
  }
}
