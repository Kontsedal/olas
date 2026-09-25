---
"@kontsedal/olas-devtools": minor
---

**`<DevtoolsLauncher>` records from mount and keeps its history when the window closes.**

The panel built its store inside itself and unmounted when the window closed or minimized, so every close wiped the recorded events. Recording also started only when the window first opened. The launcher now builds one store, attaches it on mount and hands it to the panel. `<DevtoolsPanel>` takes that store through a new optional `store` prop. The panel renders a store it is given and leaves attaching it to the store's owner.
