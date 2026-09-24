// Type-level test: each `createRealtimePatcher` handler receives its own event
// variant. Checked by `tsc` (the package typecheck), not run by vitest.
import { computed, defineController, signal } from '@kontsedal/olas-core'
import { expectTypeOf } from 'vitest'
import { createRealtimePatcher, type PatcherHandlers, type RealtimeService } from '../src'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}

type Post = { id: string; title: string }
type FeedEvent =
  | { type: 'post-updated'; post: Post }
  | { type: 'comment-added'; postId: string; text: string }
  | { type: 'post-deleted'; postId: string }

export const feed = defineController((ctx) => {
  createRealtimePatcher<FeedEvent>(ctx, 'feed', {
    'post-updated': (ev) => {
      expectTypeOf(ev).toEqualTypeOf<{ type: 'post-updated'; post: Post }>()
      expectTypeOf(ev.post).toEqualTypeOf<Post>()
    },
    'comment-added': (ev) => {
      // No narrowing on `ev.type` before reading a variant's own field.
      expectTypeOf(ev.text).toEqualTypeOf<string>()
      // @ts-expect-error: `post` belongs to another variant
      void ev.post
    },
    '*': (ev) => {
      // The wildcard sees every event, so it gets the whole union.
      expectTypeOf(ev).toEqualTypeOf<FeedEvent>()
    },
  })

  // A handler written for the whole union still fits a key.
  createRealtimePatcher<FeedEvent>(ctx, 'feed', {
    'post-deleted': (ev: FeedEvent) => void ev.type,
  })

  // A key outside the union is an error.
  createRealtimePatcher<FeedEvent>(ctx, 'feed', {
    // @ts-expect-error: 'post-created' is not a FeedEvent type
    'post-created': () => {},
  })

  // A channel is a name or a signal of one.
  const room = signal('a')
  createRealtimePatcher<FeedEvent>(
    ctx,
    computed(() => `room:${room.value}`),
    {},
  )
  // @ts-expect-error: a channel signal holds a string
  createRealtimePatcher<FeedEvent>(ctx, signal(1), {})

  return {}
})

// The map type on its own: optional keys, one variant each.
expectTypeOf<PatcherHandlers<FeedEvent>['comment-added']>().toEqualTypeOf<
  ((event: { type: 'comment-added'; postId: string; text: string }) => void) | undefined
>()
expectTypeOf<PatcherHandlers<FeedEvent>['*']>().toEqualTypeOf<
  ((event: FeedEvent) => void) | undefined
>()
