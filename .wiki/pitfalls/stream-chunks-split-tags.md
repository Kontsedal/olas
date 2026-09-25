---
name: stream-chunks-split-tags
description: A server-rendered HTML stream arrives in chunks that can end inside a tag, an attribute value or a text node, and React hydrates almost everything around them; anything written between two chunks has to go where hydration never looks.
type: pitfall
covers:
  - packages/react/src/streaming.ts:214-569
edges:
  - { type: tested-by, target: ../../packages/react/tests/streaming-security.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/streaming-hydration.test.tsx }
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../flows/ssr.md }
last_verified: 2026-09-25
confidence: medium
---

# A stream chunk can end inside a tag, or inside React's tree

## The trap

"Write a `<script>` after each chunk React writes" sounds safe, because React writes whole elements. It does not. React 19 writes its streams through fixed-size views: 2,048 bytes in the browser build of `react-dom/server`, 4,096 in the Node and edge builds (React 19.3). A string longer than a third of a view goes out as its own chunk. A chunk boundary therefore falls wherever the byte count lands: in the middle of a tag, of an attribute name, of an attribute value, or of a text node.

A `<script>` written at a boundary inside an attribute value becomes part of the value, and the first `"` in the script closes it. `createStreamingTransform` did exactly that until 1.0. The security review reproduced an XSS with it. Query data `{ bio: ' onfocus=alert(1) autofocus x=' }` became real attributes on an `<a>` in 5 of 7 chunk layouts, with no `<` in the payload at all.

The 1.0 fix wrote a batch at any chunk end that was in text, between tags. That still broke hydration, which a second review reproduced with a real `renderToReadableStream` and `hydrateRoot`. React hydrates every element it rendered, and an element it did not render is a mismatch inside any of them:
- A shell larger than a chunk, with data prefetched before render as the router README recommends, put the batch in a list item: `…Article number 41 about ri<script>…`. React reported "the server rendered text didn't match the client".
- A completed `<Suspense>` segment larger than a chunk put the batch inside `<div hidden id="S:0">`. React's reveal moves that div's children into the boundary, and the batch with them.

Waiting for a macrotask between chunks does not fix it either. Under backpressure a pipe reads a single React flush across several tasks, and Node's `renderToPipeableStream` stops mid-flush when `write` returns `false`.

## Where React never looks

React skips a stray element in two places only: the root container, and directly inside the `<html>`, `<head>` and `<body>` singletons (`canHydrateInstance` and `popHydrationState` in `react-dom-client`, 19.3). Everything between a `<Suspense>` boundary's comments, `<!--$-->` to `<!--/$-->`, is hydrated as the boundary's content, and so is `<!--&-->` for `<Activity>`. A batch is safe only outside all of that:
- directly inside `<body>` for a whole document, or at the top level for a fragment React hydrates into a container;
- outside every boundary's comments, and so outside a hidden segment until its reveal;
- right after a tag or a comment ends, since a text node there could go on in the next chunk and the batch would split it.

`<head>` is left out on purpose. A large batch there could push the `<meta charset>` declaration past the first 1,024 bytes, where a browser stops looking for it.

## The fix

`htmlBoundary()` in `packages/react/src/streaming.ts` tokenizes the bytes the transform passes through. It reads bytes, not text. UTF-8 uses no byte below 0x80 inside a multi-byte character, and every byte the tokenizer acts on is ASCII. So a chunk that ends inside a character needs no decoder. Its states are text, a tag with its quoted attribute values, a comment or doctype, and an opaque element's content. An opaque element holds raw text, like `script` or `style`, or RCDATA, like `textarea` or `title`, or it is a `template`. It also keeps a stack of open elements and boundary regions. A `/>` tag and an opaque element push nothing, and an end tag closes back to its match. React writes every void element with `/>`. An element left open, such as a hand-written `<br>`, closes with its parent, so a stray one can only hold a batch back.

`canInsert` holds when the stream sits right after a tag or a comment, with no open element but `html` and `body` and no open boundary region (`streaming.ts:333-334`). A whole document also needs an open `<body>`. A doctype, `<html>`, `<head>` or `<body>` marks a whole document. `scan(chunk)` returns the first offset in the chunk where `canInsert` holds. The transform splits the chunk there and writes the pending batch, so the data goes out before the markup that reads it. The first chunk of a document gets it right after `<body>`, and a segment's chunk gets it before the hidden `<div>`. A chunk with no such offset holds the batch, and the entries keep collecting in the hydrator. At close, `canClose` allows the final drain anywhere outside markup and outside React's tree, the end of a document included, where the parser moves a script into `<body>`. A stream that ends inside markup gets no final batch.

The rule is conservative on purpose. Markup it cannot place, such as an app template piped through the transform around React's stream, only delays batches to the end of the stream. The transform wraps React's own stream, and a template goes around its output.

Defense in depth: the payload itself is `JSON.parse("…")` over a string with every quote, angle bracket, `=`, backslash and whitespace written as `\uXXXX`. Even if a batch did land in the wrong place, the data could not form attributes.

## Where it applies

It applies to anything that injects into a server-rendered stream. That covers the Olas transform, and a hand-written Node `Transform` that calls `flush()` after each chunk, the pattern the old docs suggested. It also covers an app writing its own tags into React's output. "Between two tags" is not enough: the point must also sit outside React's hydrated tree.

Pinned by `packages/react/tests/streaming-security.test.tsx`:
- a React-shaped document and a fragment, split at every byte, each with the set of offsets a batch may take;
- a multi-byte page split inside a character;
- hostile data split at every position inside a tag. `packages/react/tests/streaming-hydration.test.tsx` runs real React streams from both server builds, a shell and a `<Suspense>` segment each larger than a chunk, through `hydrateRoot` with `onRecoverableError` watching.
