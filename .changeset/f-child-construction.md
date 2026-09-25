---
"@kontsedal/olas-core": patch
---

**Children built in unusual moments behave: under a suspended parent, inside an effect, or while the parent disposes.**

- A child built while its parent was suspended started active inside the frozen tree. That happened for a `lazyChild` load that settled during a suspension, and for `ctx.child` or `ctx.attach` called from a `ctx.on` handler. The child now starts suspended, and the parent's next resume wakes it.
- `ctx.child` and `ctx.attach` ran the child's factory inside the caller's tracking scope. An effect that attached a modal whose factory read `user.value` re-ran whenever `user` changed, disposing the modal and its draft. The factory now runs untracked, as `ctx.collection`'s already did.
- A child whose construction disposed the parent was pushed into the dead parent's cleared list, and its `onDispose` hooks never ran. It is now disposed with the parent.
- An effect registered after construction whose first run disposed its controller kept running for the rest of the program. It is now stopped, and one whose first run suspends its controller waits for the resume.
