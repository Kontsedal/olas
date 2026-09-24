---
name: stream-chunks-split-tags
description: A server-rendered HTML stream arrives in chunks that can end inside a tag or an attribute value; anything written between two chunks has to check where it lands.
type: pitfall
covers:
  - packages/react/src/streaming.ts
edges:
  - { type: tested-by, target: ../../packages/react/tests/streaming-security.test.tsx }
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../flows/ssr.md }
last_verified: 2026-09-24
confidence: medium
---

# A stream chunk can end inside a tag

## The trap

"Write a `<script>` after each chunk React writes" sounds safe, because React writes whole elements. It does not. React 19 writes its web and Node streams through fixed 2,048-byte views. A chunk boundary therefore falls wherever the byte count lands: in the middle of a tag, of an attribute name, or of an attribute value.

A `<script>` written at a boundary inside an attribute value becomes part of the value, and the first `"` in the script closes it. `createStreamingTransform` did exactly that until 1.0. The security review reproduced an XSS with it. Query data `{ bio: ' onfocus=alert(1) autofocus x=' }` became real attributes on an `<a>` in 5 of 7 chunk layouts, with no `<` in the payload at all. In the other layouts, the script landed mid-text and broke hydration.

Waiting for a macrotask between chunks does not fix it either. Under backpressure a pipe reads a single React flush across several tasks, and Node's `renderToPipeableStream` stops mid-flush when `write` returns `false`.

## The fix

Know where the markup is. `HtmlBoundary` in `packages/react/src/streaming.ts` is a small tokenizer over the bytes the transform passes through, with five kinds of state:
- text;
- inside a tag, including its quoted attribute values;
- a comment or doctype;
- the content of an opaque element: a raw-text one like `script` or `style`, RCDATA like `textarea` or `title`, or `template`, whose content never runs.

React's output is well-formed and double-quotes every attribute value, so that is enough. The transform writes a batch only when a chunk ends in text. Otherwise it holds the batch, and the entries keep collecting in the hydrator until a chunk ends between elements.

Defense in depth: the payload itself is `JSON.parse("…")` over a string with every quote, angle bracket, `=`, backslash and whitespace written as `\uXXXX`. Even if a batch did land in the wrong place, the data could not form attributes.

## Where it applies

It applies to anything that injects into a server-rendered stream. That covers the Olas transform, and a hand-written Node `Transform` that calls `flush()` after each chunk, the pattern the old docs suggested. It also covers an app writing its own tags into React's output. `flush()` on its own is safe only at a point known to be between elements, such as after the stream has ended.

Pinned by `packages/react/tests/streaming-security.test.tsx`: a React-shaped page split at every byte position, and hostile data split at every position inside a tag.
