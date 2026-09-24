---
"@kontsedal/olas-vue": minor
---

**A development build, which warns when a hook runs outside an effect scope.**

Each hook ends its signal subscriptions through `onScopeDispose`. A hook can also run outside any effect scope, from a plain module or a `setTimeout`. It still returns working refs there, but nothing ends their subscriptions. They stay live, and keep the refs in memory, for as long as the signals exist.

A development build now warns about it where it happens, once per hook. The warning names the hook and the leak. It also names the fix: call the hook from a component's `setup()`, or inside `effectScope().run()` and `stop()` the scope when you are done. `useQuery` warns as `useQuery`, not once per ref it builds.

For this the package ships two builds, as core and react do. `dist/` is the default, a production build with the warning stripped. `dist/dev/` sits behind the `development` export condition, which Vite's dev server, webpack, Rspack and Next.js resolve in development. The default build keeps its behaviour. It grows by 12 bytes brotlied, from the internal helpers the hooks now share, and stays inside its budget.
