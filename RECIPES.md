# Recipes

Copy-paste patterns for things that aren't framework primitives but show up in every non-trivial Olas app. These are **user composables** — functions you write once, drop into a project, and tweak. Olas core stays small; these grow with your needs.

Spec §16.5 documents the same patterns in narrative form. This file is the "ready to paste" version.

---

## `useDebounced` — debounce a write

When the user types into a search box, you want to query after they stop typing, not on every keystroke. `debounced` (from `@olas/core`) is a pure derived signal — no controller needed:

```ts
import { defineController, signal, debounced } from '@olas/core'

const searchController = defineController((ctx) => {
  const term = signal('')
  const debouncedTerm = debounced(term, 300)

  // a query keyed by the debounced value
  const results = ctx.use(searchQuery, () => [debouncedTerm.value])

  return { term, results }
})
```

`debounced(source, ms)` returns a `ReadSignal<T>` that reflects `source` but waits `ms` after the last write before emitting. Compose with `ctx.use` directly — the query re-keys on debounced changes, not raw ones.

For "debounce a validator," use `debouncedValidator(fn, ms)` from `@olas/core` instead — it wraps a `Validator<T>` so per-keystroke async checks don't pile up.

---

## `usePagination` — page state with sane defaults

The page-number + next/prev triad:

```ts
import type { Ctx } from '@olas/core'
import { signal } from '@olas/core'

function usePagination(_ctx: Ctx, opts: { pageSize: number; initialPage?: number } = { pageSize: 20 }) {
  const page = signal(opts.initialPage ?? 1)
  const pageSize = signal(opts.pageSize)

  return {
    page,
    pageSize,
    next: () => page.update((p) => p + 1),
    prev: () => page.update((p) => Math.max(1, p - 1)),
    setPage: (n: number) => page.set(Math.max(1, n)),
    reset: () => page.set(1),
  }
}

// usage
const listController = defineController((ctx) => {
  const pagination = usePagination(ctx, { pageSize: 25 })
  const items = ctx.use(itemsQuery, () => [pagination.page.value, pagination.pageSize.value])
  return { ...pagination, items }
})
```

`_ctx` is unused here, but pinning the convention (`ctx` first) makes it obvious which composables are lifecycle-bound (when they grow to need it).

---

## `useSubmit` — validate then mutate

```ts
import type { Ctx, Form, Mutation, ReadSignal } from '@olas/core'

function useSubmit<T, R>(
  ctx: Ctx,
  form: Form<any> & { value: ReadSignal<T> },
  mutate: (data: T, signal: AbortSignal) => Promise<R>,
): Mutation<void, R> {
  return ctx.mutation({
    mutate: async (_: void, signal) => {
      form.markAllTouched()
      const valid = await form.validate()
      if (!valid) throw new Error('Form invalid')
      return mutate(form.value.value as T, signal)
    },
    onSuccess: () => form.reset(),
  })
}

// usage
const profileController = defineController((ctx) => {
  const form = ctx.form({ name: ctx.field('') })
  const save = useSubmit(ctx, form, (data, signal) => ctx.deps.api.saveProfile(data, { signal }))
  return { form, save }
})
```

`save.run()` triggers validate-then-mutate. `save.isPending` / `save.error` are signals you can bind in the UI.

---

## `useInlineEdit` — click-to-edit a cell

```ts
import type { Ctx } from '@olas/core'
import { signal } from '@olas/core'

function useInlineEdit<T>(
  ctx: Ctx,
  current: () => T,
  save: (value: T, signal: AbortSignal) => Promise<void>,
) {
  const isEditing = signal(false)
  const draft = signal<T | undefined>(undefined)

  const start = () => {
    draft.set(current())
    isEditing.set(true)
  }
  const cancel = () => {
    draft.set(undefined)
    isEditing.set(false)
  }
  const commit = ctx.mutation({
    mutate: (_: void, signal) => save(draft.peek() as T, signal),
    onSuccess: () => {
      draft.set(undefined)
      isEditing.set(false)
    },
  })

  return { isEditing, draft, start, cancel, commit }
}
```

`current` is a thunk so the edit-start reads the latest server value, not a stale snapshot.

---

## `useTail` — bounded live stream with backpressure

For WebSocket / SSE streams firing 10–1000 events/sec, rendered live:

```ts
import type { Ctx } from '@olas/core'
import { signal } from '@olas/core'

function useTail<T>(
  ctx: Ctx,
  subscribe: (push: (item: T) => void) => () => void,
  options: { capacity: number; flushMs?: number } = { capacity: 10_000, flushMs: 16 },
) {
  const buffer = signal<T[]>([])
  const isPaused = signal(false)
  let pending: T[] = []
  let flushTimer: number | null = null

  ctx.effect(() => {
    if (isPaused.value) return
    const unsub = subscribe((item) => {
      pending.push(item)
      if (flushTimer == null) {
        flushTimer = window.setTimeout(() => {
          const next = [...buffer.peek(), ...pending]
          if (next.length > options.capacity) next.splice(0, next.length - options.capacity)
          buffer.set(next)
          pending = []
          flushTimer = null
        }, options.flushMs ?? 16)
      }
    })
    return () => {
      unsub()
      if (flushTimer != null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
    }
  })

  return {
    items: buffer,
    isPaused,
    pause: () => isPaused.set(true),
    resume: () => isPaused.set(false),
  }
}
```

`flushMs` coalesces N events into one UI update — prevents 1000 renders/sec. `capacity` caps memory; oldest entries drop.

---

## `useRealtimePatcher` — WebSocket events → cache mutations

```ts
import type { Ctx } from '@olas/core'

function useRealtimePatcher<TEvent extends { type: string }>(
  ctx: Ctx,
  channel: string,
  handlers: Partial<Record<TEvent['type'], (ev: TEvent) => void>>,
) {
  ctx.effect(() => {
    const sub = ctx.deps.realtime.subscribe(channel, (ev: TEvent) => {
      handlers[ev.type as TEvent['type']]?.(ev)
    })
    return () => sub.unsubscribe()
  })
}

// usage
useRealtimePatcher<FeedEvent>(ctx, 'feed-events', {
  'like-added': (ev) => newsfeedQuery.setData('top-stories', (pages) => /* patch */),
  'comment-added': (ev) => commentsQuery.setData(ev.postId, (prev) => [...(prev ?? []), ev.comment]),
  'post-deleted': () => newsfeedQuery.invalidateAll(),
})
```

Requires a `realtime` service in deps with `subscribe(channel, handler)`. The framework primitive is `ctx.effect` + `setData`; this just wraps the dispatching boilerplate.

---

## When to lift to a package

If a composable ends up:

- Used in ≥3 unrelated controllers in your codebase, or
- Has its own meaningful tests, or
- Encapsulates non-trivial async/timing logic that would be easy to get wrong,

…then it belongs in its own file (or a shared internal `composables/` directory). Resist publishing to npm unless someone else asks — composables are easy to copy, and divergence is fine.
