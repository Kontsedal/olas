---
"@kontsedal/olas-core": patch
---

**Reads and teardown behave after a controller is gone, and a child that fails to build reports `kind: 'construction'` everywhere.**

`ctx.inject` and `root.inject` threw "no provider" after dispose. SPEC §4 says reads do not throw, so they now return what the scope resolved to while the controller was live. `root.suspend({ maxIdleTime })` after `root.dispose()` armed a real timer; it now does nothing.

A failed construction rolled back with the controller still marked as constructing. A teardown hook that called `ctx.effect` or `ctx.child` registered into a list that was then dropped, and the new effect ran on for good. The rollback now marks the controller disposed first, as `dispose()` does, so that call throws and reaches `onError`.

A `ctx.child` or `ctx.attach` whose factory threw inside an effect reached `onError` as `kind: 'effect'`, and inside a `ctx.on` handler as `'emitter'`. SPEC §12.1.6 names these construction errors, and they now report `kind: 'construction'` wherever the throw is caught.

Devtools subscribers to `root.debug` now run untracked. A subscriber that read a signal while a field validated made that signal a dependency of the validator, so a write to it re-ran the validation.
