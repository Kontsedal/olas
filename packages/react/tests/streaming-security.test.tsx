// @vitest-environment jsdom

/**
 * The streamed hydration scripts against hostile query data and hostile
 * placement: a chunk boundary inside a tag, a `__proto__` key, line
 * separators, a CSP nonce, and a page element that clobbers the intake global.
 */
import { createRoot, defineController, defineQuery, queryEngine } from '@kontsedal/olas-core'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createStreamingHydrator,
  createStreamingTransform,
  htmlBoundary,
  OLAS_BOOTSTRAP_SCRIPT,
  STREAMING_GLOBAL,
} from '../src/streaming'
import { entriesOf, runFlushed, scriptBodies } from './_streaming'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[STREAMING_GLOBAL]
})

/** A stand-in hydrator batch, the way `flush()` returns one. */
const SCRIPT = '<script>self.x=1</script>'

async function pipe(chunks: string[], flush: () => string): Promise<string> {
  const enc = new TextEncoder()
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
  const reader = source.pipeThrough(createStreamingTransform(flush)).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out += dec.decode(value, { stream: true })
  }
}

/** `pipe` over raw bytes, so a chunk can end inside a multi-byte character. */
async function pipeBytes(chunks: Uint8Array[], flush: () => string): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const reader = source.pipeThrough(createStreamingTransform(flush)).getReader()
  const parts: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A flush with one batch pending from the start, the way prefetched data leaves it. */
const once = (): (() => string) => {
  let calls = 0
  return () => {
    calls += 1
    return calls === 1 ? SCRIPT : ''
  }
}

/** Where `SCRIPT` landed in `out`, checked to be the only change to `page`. */
function placement(out: string, page: string): number {
  expect(out.replace(SCRIPT, '')).toBe(page)
  return out.indexOf(SCRIPT)
}

/** The offsets right after each occurrence of `markers` in `page`. */
const after = (page: string, ...markers: string[]): number[] =>
  markers.map((marker) => {
    const at = page.indexOf(marker)
    expect(at, marker).toBeGreaterThanOrEqual(0)
    return at + marker.length
  })

// A React-shaped document: quoted attributes carrying user data (React
// escapes `"`, `<`, `>` and `&` inside them), a completed Suspense boundary's
// comments, raw-text elements and an empty template.
const PAGE =
  '<!DOCTYPE html><html><head><title>A &lt;b&gt; page</title><style>a>b{color:red}</style></head>' +
  '<body><div id="root"><!--$--><a href="/u/1" title=" onfocus=alert(1) autofocus x=">Ada</a>' +
  '<p class="bio">x onfocus=alert(1) autofocus</p><template id="B:0"></template>' +
  '<script>$RC=function(a,b){return a<b}</script><!--/$--></div></body></html>'

// A React-shaped fragment, as `renderToReadableStream` writes one for a root
// hydrated into a container: a shell with a pending boundary, the bootstrap,
// then a completed segment and its reveal.
const FRAGMENT =
  '<main><h1>Tides &amp; rivers</h1><!--$?--><template id="B:0"></template><p>loading…</p>' +
  '<!--/$--></main><script>requestAnimationFrame(function(){$RT=performance.now()});</script>' +
  '<script id="_R_">self.boot=1</script><div hidden id="S:0"><ol><li>Line <b>one</b></li>' +
  '<li>Line two</li></ol></div><script>$RC("B:0","S:0")</script>'

describe('createStreamingTransform places a batch only where hydration never sees it', () => {
  test('a document: split anywhere, the batch goes directly inside <body>, outside the app', async () => {
    // Directly inside <body>, after a tag: right after `<body>` or after the
    // app's root element closes. Never in <head>, never inside <div id="root">.
    const allowed = after(PAGE, '<body>', '<!--/$--></div>')
    for (let at = 1; at < PAGE.length; at++) {
      const out = await pipe([PAGE.slice(0, at), PAGE.slice(at)], once())
      const position = placement(out, PAGE)
      expect(allowed, `split at ${at}`).toContain(position)
      const before = htmlBoundary()
      before.feed(out.slice(0, position))
      expect(before.canInsert, `split at ${at}`).toBe(true)
    }
  })

  test('a fragment: split anywhere, the batch stays at the top level, out of every boundary', async () => {
    // Top level, after a tag: after the shell's <main>, a script or the
    // hidden segment. Never inside a list item's text, inside the boundary's
    // comments, or inside <div hidden id="S:0">, whose children React's
    // reveal moves into the boundary.
    const allowed = after(
      FRAGMENT,
      '</main>',
      '$RT=performance.now()});</script>',
      'self.boot=1</script>',
      '</ol></div>',
      '$RC("B:0","S:0")</script>',
    )
    for (let at = 1; at < FRAGMENT.length; at++) {
      const out = await pipe([FRAGMENT.slice(0, at), FRAGMENT.slice(at)], once())
      expect(allowed, `split at ${at}`).toContain(placement(out, FRAGMENT))
    }
  })

  test('a batch pending from the start goes out before the markup that follows it', async () => {
    // Three chunks, each ending right after a top-level element: the batch
    // takes the first point, the end of the first chunk.
    const out = await pipe(['<h1>a</h1>', '<p>b</p>', '<p>c</p>'], once())
    expect(out).toBe(`<h1>a</h1>${SCRIPT}<p>b</p><p>c</p>`)
  })

  test('bytes pass through unchanged when a chunk ends inside a multi-byte character', async () => {
    const page = '<main><p>Tïdës — ≠ 🌊</p></main><p>déjà vu</p>'
    const bytes = new TextEncoder().encode(page)
    for (let at = 1; at < bytes.length; at++) {
      const out = await pipeBytes([bytes.subarray(0, at), bytes.subarray(at)], once())
      const text = new TextDecoder().decode(out)
      expect(text.replace(SCRIPT, ''), `split at byte ${at}`).toBe(page)
      expect(text.indexOf(SCRIPT), `split at byte ${at}`).toBe(page.indexOf('<p>déjà'))
    }
  })

  test('a batch held at a mid-tag chunk end goes out at the next point, whole', async () => {
    let n = 0
    const out = await pipe(['<a title="x', ' y">hi</a>', '<p>z</p>'], () => {
      n += 1
      // Two batches; the close-time drain finds nothing more.
      return n <= 2 ? `<script>${n}</script>` : ''
    })
    // After chunk 1 the stream is mid-attribute, so nothing is flushed there.
    // Chunk 3 starts at a point, so its batch goes before its markup.
    expect(out).toBe('<a title="x y">hi</a><script>1</script><script>2</script><p>z</p>')
  })

  test('a stream that ends inside markup gets no final batch', async () => {
    const out = await pipe(['<main><p>cut short'], once())
    expect(out).toBe('<main><p>cut short')
  })

  test('the close-time drain goes after a document that ended, where the parser puts it in <body>', async () => {
    const page = '<!DOCTYPE html><html><head></head><body><div>app</div></body></html>'
    let calls = 0
    // Nothing pending mid-stream; one batch settles after the last chunk.
    const out = await pipe([page], () => {
      calls += 1
      return calls === 2 ? SCRIPT : ''
    })
    expect(out).toBe(`${page}${SCRIPT}`)
    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(doc.querySelector('script')?.parentElement).toBe(doc.body)
  })

  test('hostile query data cannot become attributes, wherever React ends a chunk', async () => {
    // The exploit the security review reproduced: data shaped like attributes,
    // and a chunk that ends inside an attribute value.
    const q = defineQuery({
      id: 'security/attributes',
      key: () => [],
      fetcher: async () => ({ bio: ' onfocus=alert(1) autofocus x=' }),
    })
    const page = '<div><a href="/u/1" class="profile link" title="Ada Lovelace">Ada</a></div>'
    const tagStart = page.indexOf('<a ')
    const tagEnd = page.indexOf('>', tagStart)
    for (let at = tagStart + 1; at < tagEnd; at++) {
      const { plugin, flush, dispose } = createStreamingHydrator()
      const root = createRoot(
        defineController(() => ({})),
        {
          queries: queryEngine(),
          deps: {},
          plugins: [plugin],
        },
      )
      await root.bindQuery(q).prefetch()
      const html = await pipe([page.slice(0, at), page.slice(at)], flush)
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const link = doc.querySelector('a')
      expect(link?.getAttributeNames(), `split at ${at}`).toEqual(['href', 'class', 'title'])
      dispose()
      root.dispose()
    }
  })
})

describe('the flushed payload', () => {
  const flushWith = async (data: unknown, options?: { nonce?: string }) => {
    const q = defineQuery({ id: 'security/payload', key: () => [], fetcher: async () => data })
    const { plugin, flush, dispose } = createStreamingHydrator(options)
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [plugin],
      },
    )
    await root.bindQuery(q).prefetch()
    const html = flush()
    dispose()
    root.dispose()
    return html
  }

  test('an own __proto__ key stays an own property on the client', async () => {
    const html = await flushWith(JSON.parse('{"__proto__":{"isAdmin":true},"a":1}'))
    const data = entriesOf(html)[0]?.data as Record<string, unknown>
    expect(Object.hasOwn(data, '__proto__')).toBe(true)
    expect(data.isAdmin).toBeUndefined()
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype)
  })

  test('U+2028 and U+2029 reach the script only as escapes', async () => {
    const text = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`
    const html = await flushWith(text)
    expect(html.includes(String.fromCharCode(0x2028))).toBe(false)
    expect(html.includes(String.fromCharCode(0x2029))).toBe(false)
    expect(entriesOf(html)[0]?.data).toBe(text)
  })

  test('the payload carries no quote, angle bracket or equals sign raw', async () => {
    const html = await flushWith({ bio: '" onfocus=alert(1) \'<b>' })
    const body = scriptBodies(html)[0] ?? ''
    const argument = body.slice(body.indexOf('JSON.parse("') + 'JSON.parse("'.length)
    const literal = argument.slice(0, argument.indexOf('"'))
    expect(literal).not.toMatch(/["'<>=]/)
    expect(entriesOf(html)[0]?.data).toEqual({ bio: '" onfocus=alert(1) \'<b>' })
  })

  test('a CSP nonce goes on every tag, escaped for its attribute', async () => {
    const html = await flushWith(1, { nonce: 'r4nd"om' })
    expect(html.startsWith('<script nonce="r4nd&quot;om">')).toBe(true)
  })
})

describe('a page element clobbering the intake global', () => {
  test('the bootstrap and a flush replace a global that is not an intake', async () => {
    // A DOM element with id="__OLAS_HYDRATION__" is reachable as a global.
    const self: Record<string, unknown> = { [STREAMING_GLOBAL]: { tagName: 'DIV' } }
    new Function('self', 'window', OLAS_BOOTSTRAP_SCRIPT)(self, self)
    expect(typeof (self[STREAMING_GLOBAL] as { push?: unknown }).push).toBe('function')

    const clobbered: Record<string, unknown> = { [STREAMING_GLOBAL]: { tagName: 'DIV' } }
    const q = defineQuery({ id: 'security/clobber', key: () => [], fetcher: async () => 'ok' })
    const { plugin, flush, dispose } = createStreamingHydrator()
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [plugin],
      },
    )
    await root.bindQuery(q).prefetch()
    const batches = runFlushed(flush(), clobbered)
    expect(batches.flat().map((e) => e.data)).toEqual(['ok'])
    dispose()
    root.dispose()
  })
})
