---
"@kontsedal/olas-react": patch
---

**A development build warns when `HydrationBoundary` renders on the server.**

`HydrationBoundary` builds its root during render and disposes it in an effect cleanup. A server render runs no effects, so each request left a root alive, with its timers and plugins. The boundary now warns once per process when it renders without a `window`. The warning names the fix: on the server, create a root per request, render it through `<OlasProvider root={root}>`, and call `root.dispose()` after the response. Production builds carry no warning.
