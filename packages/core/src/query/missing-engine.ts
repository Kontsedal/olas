/**
 * The "you forgot the query engine" error, deliberately in its own module.
 *
 * `controller/instance.ts` and `controller/root.ts` both need to throw it, and
 * both are statically reachable from `createRoot`. If this lived in
 * `query/engine.ts` — which imports `QueryClient` by value — then `createRoot`
 * would still hold a value edge into the cache engine, and the exclusion would
 * rest entirely on a bundler's export-level dead-code elimination rather than
 * on the module graph.
 *
 * Keeping it here makes the guarantee structural: nothing reachable from
 * `createRoot` imports `query/engine.ts` at all, so `query/client.ts` is out
 * of the graph unless the consumer imports `queryEngine` themselves.
 */
export function missingQueryEngine(operation: string): Error {
  return new Error(
    `[olas] ${operation} needs a query engine. Pass one to createRoot: ` +
      "createRoot(def, { deps, queries: queryEngine() }) — import { queryEngine } from '@kontsedal/olas-core'.",
  )
}
