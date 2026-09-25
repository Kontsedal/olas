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
  HtmlBoundary,
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

// React-shaped markup: quoted attributes carrying user data (React escapes
// `"`, `<`, `>` and `&` inside them), a comment marker, raw-text elements and
// an empty template, as a Suspense boundary emits.
const PAGE =
  '<!DOCTYPE html><html><head><title>A &lt;b&gt; page</title><style>a>b{color:red}</style></head>' +
  '<body><div id="root"><!--$--><a href="/u/1" title=" onfocus=alert(1) autofocus x=">Ada</a>' +
  '<p class="bio">x onfocus=alert(1) autofocus</p><template id="B:0"></template>' +
  '<script>$RC=function(a,b){return a<b}</script><!--/$--></div></body></html>'

describe('createStreamingTransform places a batch only between elements', () => {
  test('split anywhere, a batch never lands inside a tag, an attribute, a comment or raw text', async () => {
    for (let at = 1; at < PAGE.length; at++) {
      let calls = 0
      const out = await pipe([PAGE.slice(0, at), PAGE.slice(at)], () => {
        calls += 1
        return calls === 1 ? SCRIPT : ''
      })
      // Removing the batch gives back the page byte for byte.
      expect(out.replace(SCRIPT, '')).toBe(PAGE)
      const position = out.indexOf(SCRIPT)
      const before = new HtmlBoundary()
      before.feed(out.slice(0, position))
      expect(before.atBoundary, `split at ${at}`).toBe(true)
    }
  })

  test('a batch held at a mid-tag chunk end goes out at the next boundary, whole', async () => {
    let n = 0
    const out = await pipe(['<a title="x', ' y">hi</a>', '<p>z</p>'], () => {
      n += 1
      // Two batches; the close-time drain finds nothing more.
      return n <= 2 ? `<script>${n}</script>` : ''
    })
    // After chunk 1 the stream is mid-attribute, so nothing is flushed there.
    expect(out).toBe('<a title="x y">hi</a><script>1</script><p>z</p><script>2</script>')
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
