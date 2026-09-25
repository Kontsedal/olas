---
"@kontsedal/olas-react": patch
---

**`<SuspendOnUnmount>` and `useSuspendOnHidden` on one controller no longer undo each other.**

Unmounting a wrapped subtree while the tab was hidden ran the wrapper's cleanup, which suspended the controller, and then the hook's cleanup, which resumed it. The unmounted screen's controller was left running. The two helpers now share one record of why each controller is suspended, and the controller resumes only when no reason is left. A wrapper that first mounts on a hidden tab waits for the tab to show. A tab that shows does not resume a controller whose last wrapper has unmounted.
