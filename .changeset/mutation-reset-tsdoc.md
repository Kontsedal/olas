---
"@kontsedal/olas-core": patch
---

Docs: `Mutation.reset()`'s TSDoc claimed the opposite of what it does.

The doc line read "Clear `data` / `error` / `lastVariables` / `status` **without aborting in-flight runs**". `reset()` has aborted in-flight runs since the file's first commit, SPEC §6.2 lists it among the abort triggers, and two tests pin it (`mutation.test.ts` "reset clears data/error/lastVariables and aborts in-flight", regression B2 for the queued-`serial` rejection). The sentence was introduced by a docs-only sweep and was never true — it shipped in the published `.d.ts`, so consumers read it in editor hover.

No behavior change. The TSDoc now states it plainly: in-flight runs abort (awaiters reject with an `AbortError`), queued `serial` runs are rejected so nothing hangs, then `data` / `error` / `lastVariables` / `status` clear and `isPending` drops.

It also carries a migration warning, because this is a real footgun: react-query's `reset()` detaches the observer and lets the in-flight request finish, Olas's aborts it. Same name, same signature, no type error — a mechanical `reset()` → `reset()` port silently changes whether the write lands. `API.md` and `MIGRATING.md` say the same thing now.
