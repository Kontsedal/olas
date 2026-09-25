---
"@kontsedal/olas-react": patch
---

**Streaming SSR hydrates without a mismatch: batches land where React never hydrates, and the boundary reads the ones already on the page.**

`createStreamingTransform` wrote a batch at the end of any chunk that ended in text. React writes 2,048- or 4,096-byte chunks. A large shell put the `<script>` inside a list item's text, and a large `<Suspense>` segment put it inside `<div hidden id="S:0">`, which React's reveal moves into the boundary. Both broke hydration. The transform now writes a batch only directly inside `<body>` for a whole document, or at the top level for a fragment. The point must be outside every boundary's comments and right after a tag or a comment. The batch goes at the first such point in a chunk, so data goes out before the markup that reads it. A chunk with no such point holds the batch. A stream that ends inside markup gets no final batch.

`HydrationBoundary` applied the streamed batches only in an effect after its first commit. So the hydrating render showed loading states where the server had rendered data, and each controller started the fetch the server had already made. The batches already on the page now go into the root's `hydrate` as the boundary builds it. A retry that reuses the root first applies the batches that arrived since, and later ones arrive through the intake as before.

A root the boundary builds for a new `def` no longer receives the stream. Its intake used to replay every batch seen so far, which put the first tree's server rows over the new root's own fetch.
