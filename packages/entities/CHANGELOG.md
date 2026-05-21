# @kontsedal/olas-entities

## 0.0.2

### Patch Changes

- Round of correctness fixes from a multi-agent code review.

  **Core**

  - `isAbortError`: now matches any object whose `name === 'AbortError'`, not just
    `DOMException`. axios / msw / custom plain Errors that signal abort no longer
    trip retry loops.
  - `createEmitter`: emit-time handler throws are isolated — one throwing handler
    no longer blocks subsequent handlers (spec §20.6). `createEmitter({ onError })`
    accepts a reporter; `ctx.emitter()` wires it to the root's `onError` with
    `kind: 'emitter'`.
  - `readOnly()`: returned object is now `Object.freeze`d so `(ro as any).value = …`
    throws in strict mode rather than silently mutating.
  - `debounced` / `throttled`: both accept an optional `{ signal: AbortSignal }`
    so the internal effect, pending timer, and `source` subscription can be torn
    down. Without it the helpers retain the source for the program's lifetime —
    pass a signal whenever the source outlives the consumer.
  - `ctx.lazyChild`: explicit `lazyChild.dispose()` now also splices the internal
    parent-dispose flag entry. Prior code left one closure on the parent's
    lifecycle list per ever-disposed lazyChild — slow leak in apps that repeatedly
    open and close code-split children.
  - `Form.set({ tags: [...] })`: array-shaped patches now preserve item identity
    on overlapping indices instead of `clear() + add()`-ing every position.
    Touched / dirty / in-flight validators on existing items survive the patch.
    `resetWithInitial` also re-anchors `initialItems` on the underlying
    `FieldArray` so a later `reset()` returns to the most-recently-applied initial.

  **Entities**

  - `entities.update()` on an id that isn't in the store no longer allocates an
    empty slot via `getSlot`. Under `maxSlots`, the orphan allocation could
    LRU-touch a never-seen id ahead of real entities and trigger spurious
    eviction. The no-op path is now truly side-effect-free.

  **Cross-tab**

  - The internal `seenByPeer` Map is now bounded (cap 64) with LRU-style
    eviction. A long-lived tab seeing many short-lived peers no longer grows
    this Map without bound, and `dispose()` clears it.

  **Devtools**

  - `TreeView` rules-of-hooks bug: `useMemo` was called after an early-return
    on empty trees, so the hook order changed across renders. Now computed
    unconditionally.

- Updated dependencies
- Updated dependencies [6869769]
- Updated dependencies [7a07994]
  - @kontsedal/olas-core@0.0.2

## 0.0.1-rc.1

Initial release. Entity-normalization plugin.

- `defineEntity({ name, idOf })` — declare an entity type with an id extractor.
- `entitiesPlugin([Post, User, ...])` — installs as `QueryClientPlugin`. Observes
  every `SetDataEvent` (fetch / set / remote) and walks query data to populate an
  internal normalized store plus a reverse index of (entity-id → queries holding it).
- `entities.signal(Post, id)` — `ReadSignal<Post | undefined>` for per-entity
  subscriptions. Components consume via `use(...)` from `@kontsedal/olas-react`.
- `entities.upsert(Post, raw)` — explicit branding (for events / non-query sources).
- `entities.update(Post, id, patchOrUpdater)` — accepts `Partial<T>` (shallow merge)
  OR `(prev: T) => T` (updater function). Patches every query holding the id via
  `QueryClientPluginApi.setEntryData`. Batched into one notification round.
  Warns in dev when the entity isn't in the store.
- `entities.get(Post, id)` / `entities.invalidate(Post, id)` — non-reactive read /
  store removal.
- `entities.entries(Post)` / `entities.bindings(Post, id)` — devtools snapshots of
  the normalized store and the reverse index.

Notable behaviors:

- Walker uses stack-based cycle detection (`WeakSet` of currently-descending nodes),
  so shared-reference DAGs walk both paths but true cycles still terminate.
- Path accumulator is mutable across the walk; clones happen only at binding
  boundaries (push/pop on descent/ascent).
- `bindingKey` uses the core `stableHash` (now re-exported) so Date / undefined /
  key-ordering match the QueryClient's own entry hash.
- All public methods throw when called with an `EntityDef` that wasn't passed to
  `entitiesPlugin([...])`.
- Dev builds emit a one-shot warning when a single entity partition crosses 10k
  unique ids in the slot map.
