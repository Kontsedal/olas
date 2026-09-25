---
"@kontsedal/olas-vue": patch
---

**`useValue`'s `isEqual` keeps the value it showed, as in React, and `useRoot()` outside `setup()` throws an olas message.**

With `isEqual`, a write that `isEqual` called equal did not trigger the component, but the ref's getter read the signal's current value. A component that re-rendered for another reason then showed the new value, where React's `useValue` keeps the previous one. The ref now keeps returning the value it last returned while `isEqual` calls the new one equal to it. The adapter-parity suite runs the case through React, Preact and Vue.

`useRoot()` called outside a component's `setup()` threw `TypeError: Cannot read properties of undefined (reading 'api')`, because Vue's `inject` returns `undefined` there, not the default. It now throws `[olas] useRoot() found no root`, naming `setup()` and `app.runWithContext()`, without Vue's own warning.
