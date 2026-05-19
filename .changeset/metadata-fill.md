---
"@kontsedal/olas-core": patch
"@kontsedal/olas-react": patch
"@kontsedal/olas-zod": patch
"@kontsedal/olas-persist": patch
"@kontsedal/olas-devtools": patch
"@kontsedal/olas-realtime": patch
"@kontsedal/olas-cross-tab": patch
---

Fill npm package metadata.

Every publishable package now has `repository` (linking npm → github source
directory), `homepage` (deep-linking the per-package README), `bugs.url`
(github issues), `author` (Bohdan Kontsedal), and a focused `keywords`
list. Descriptions tightened to one sentence each. No code change — purely
manifest metadata that surfaces on the npm package page.
