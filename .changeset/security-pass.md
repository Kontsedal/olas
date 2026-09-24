---
"@kontsedal/olas-core": minor
"@kontsedal/olas-react": minor
"@kontsedal/olas-mutation-queue": patch
"@kontsedal/olas-persist": patch
"@kontsedal/olas-cross-tab": minor
"@kontsedal/olas-entities": patch
---

**Security pass: streamed SSR, stored state, and prototype keys.** SPEC §22 now states what Olas trusts and what it checks.

**react.**
- **XSS fix: `createStreamingTransform` writes a hydration batch only between elements.** React writes its stream in fixed-size chunks, so a chunk can end inside a tag or an attribute value. The transform used to write a `<script>` after every chunk. The payload's quotes could then close the attribute and turn query data into new attributes, such as an event handler. The transform now tracks the markup it passes through, and holds a batch until a chunk ends between elements.
- **The streamed payload is `JSON.parse("…")` over a fully escaped string.** An own `__proto__` key in query data stays a property on the client. Before, it became the object's prototype. No quote, angle bracket, `=`, U+2028 or U+2029 reaches the script raw.
- **New: `createStreamingHydrator({ nonce })`** puts a CSP nonce on every tag it emits.
- **A page element with the id `__OLAS_HYDRATION__` no longer breaks streamed hydration.** The bootstrap and each batch check that the global is the intake.

**core.**
- **New: `serializeForScript(value)`**, the escaping the streaming hydrator uses, for any state an app inlines into a page: `<script>window.__OLAS_STATE__ = ${serializeForScript(root.dehydrate())}</script>`.
- **New: `host.mutations.get(id)`** returns a registered definition's `id` and `meta`.
- **Hydration skips an entry it cannot read**, such as `null` or a key nested too deep to hash, and hydrates the rest. Before, one bad entry made `createRoot({ hydrate })` throw.
- **`Form.set` and `setAsInitial` ignore keys the form does not own.** A partial parsed from JSON with a `__proto__`, `constructor` or `toString` key used to throw.

**mutation-queue.**
- **Replay runs only mutations whose definition has `meta.persist: true`.** An entry in storage could name any registered mutation and have it run on the next load.
- **An entry stored under a key its contents do not name is dropped.** Every later write and delete used the contents' key. So such an entry stayed in storage and replayed on every load. A `migrate` that renames the mutation hit the same loop; the migrated entry is now rewritten under its new key and the old one deleted.
- **Entries are checked in full.** The attempt count must be a whole, non-negative number, `seq` finite, and `enqueuedAt` no later than a few minutes from now, so a future timestamp cannot escape `ttlMs`.

**persist.**
- **`persistQueryCachePlugin` drops a stored entry dated in the future.** It passed `maxAgeMs` and stayed fresh for any `staleTime`, so planted data never refetched.
- **An async restore that fails now reaches `onError`**, as a sync one does.
- **`createPersisted` reports a stored value its source refuses as `'deserialize'`**, and still settles `ready`. It used to leave `ready` false and stop persisting.

**cross-tab.**
- **A peer message the engine cannot apply is reported through `onWarn`**, not thrown out of the channel's handler.
- **A `msgId` that is not a safe non-negative integer is ignored.** `Number.MAX_VALUE` posted under a peer's id used to silence that peer.
- **New: `validate(queryId, data)` option** to reject a payload shape this tab does not expect.

**entities.** **`entities.update(…, { merge: 'deep' })` keeps a `__proto__` key in the patch as data.** It used to replace the merged entity's prototype.
