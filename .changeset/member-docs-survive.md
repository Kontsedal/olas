---
"@kontsedal/olas-core": patch
"@kontsedal/olas-cross-tab": patch
"@kontsedal/olas-devtools": patch
"@kontsedal/olas-entities": patch
"@kontsedal/olas-mutation-queue": patch
"@kontsedal/olas-persist": patch
"@kontsedal/olas-react": patch
"@kontsedal/olas-realtime": patch
"@kontsedal/olas-svelte": patch
"@kontsedal/olas-vue": patch
"@kontsedal/olas-zod": patch
---

**Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
