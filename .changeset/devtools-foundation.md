---
'@kontsedal/olas-devtools': minor
'@kontsedal/olas-core': minor
---

The panel scales to a long session: bounded memory, windowed views, one search box and a lane
per plugin.

- **Ring buffer.** The timeline keeps the newest 10,000 events and counts the ones it
  overwrote. The count shows in the timeline's toolbar, and Clear resets it. The new
  `maxTimelineEntries` prop on `DevtoolsPanel` and `DevtoolsLauncher` sets the capacity, and
  `DevtoolsStore.droppedEvents$` exposes the count. The cache, mutation and field logs use the
  same ring at their `maxEntries` cap.
- **Windowed views.** The timeline, the tree and the four log lists mount only the rows in
  view. A row keeps its expanded state when it scrolls away. The tree renders as flat rows with
  `aria-level` and a collapse chevron per parent. An open cause-group shows 100 events at a
  time, with a button for the rest.
- **Keyed tree.** Applying an event costs constant time plus the path depth. The old tree
  scanned siblings on every event and walked the whole tree on every dispose. Unchanged
  subtrees keep their object identity between `tree$` reads.
- **Disposed controllers.** They stay in the tree, greyed, up to `maxDisposedNodes`, and their
  `ctx.debug` values freeze at dispose time. `ControllerNode.disposedAt` records when. Pruning
  now drops the earliest-disposed subtree first rather than the earliest-constructed one.
- **Omnibox.** A search box above the tabs, focused with `/`, finds controllers, query ids,
  key args, mutations, form fields and payload content. Results are grouped by kind, and Enter
  jumps to the row and highlights it. The index is built on the first search after a change,
  so typing does not re-stringify anything. `DevtoolsStore.search()` is the same search
  without the UI.
- **Plugin lanes.** An event a plugin publishes through `host.debug` is badged with the
  plugin's name, and a chip per lane shows or hides that lane's events.
- **URL hash hardening.** With `urlHashKey`, the panel now validates the state it reads from
  the hash. A crafted link with a non-string filter used to throw during render and unmount the
  whole host app. An unknown tab, a non-string filter or a non-object value now falls back to
  the defaults (W15 security review, L7).
- **Smaller stylesheet.** The build minifies the inline CSS, which saves 2.1 KB brotli.

Type changes: `DevtoolsStore`'s `tree$`, `cache$`, `mutations$`, `fields$` and `events$` are
`ReadSignal`s. The store derives them from its rings and its tree, so there was nothing a
caller could usefully write. The default for the `maxTimelineEntries` store option rises from
500 to 10,000.

**core: `DebugCacheEntry` carries its `queryId`.** `root.debug.queryEntries()` identified an entry by its key alone, so two queries holding entries under the same key looked like one in the panel: one label, duplicate list keys, and a shared diff baseline. The panel now identifies an entry by its query id and key.
