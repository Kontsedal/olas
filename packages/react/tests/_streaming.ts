// Test helper: run the `<script>` tags in streamed HTML the way a browser
// would, against a stand-in for `self`, and return every batch they pushed.
import { STREAMING_GLOBAL } from '../src/streaming'

export type Shipped = {
  queryId: string
  key: unknown[]
  data: unknown
  lastUpdatedAt: number
  pageParams?: unknown[]
}

const SCRIPT = /<script(?: nonce="[^"]*")?>([\s\S]*?)<\/script>/g

/** Every script body in `html`, in order. */
export const scriptBodies = (html: string): string[] =>
  [...html.matchAll(SCRIPT)].map((match) => match[1] ?? '')

/** Run each script in `html` against `self`, and return the intake's queue. */
export function runFlushed(html: string, self: Record<string, unknown> = {}): Shipped[][] {
  for (const body of scriptBodies(html)) new Function('self', body)(self)
  const intake = self[STREAMING_GLOBAL] as { q: Shipped[][] } | undefined
  return intake?.q ?? []
}

/** The entries of the one batch in `html`. */
export const entriesOf = (html: string): Shipped[] => runFlushed(html).flat()
