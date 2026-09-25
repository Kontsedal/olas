---
"@kontsedal/olas-codemod": patch
---

**`use-controller` rewrites `useController` behind a namespace import.**

A call through a namespace import, `OlasReact.useController(root)` after `import * as OlasReact from '@kontsedal/olas-react'`, was neither rewritten nor reported. The migrated code then failed to compile against 1.0. The call now becomes `root.api`, and any other use of `OlasReact.useController` is reported.
