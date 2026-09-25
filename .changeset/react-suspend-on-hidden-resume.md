---
"@kontsedal/olas-react": patch
---

`useSuspendOnHidden` now resumes the controller when its effect goes.

Unmounting a subtree while the tab was hidden left the controller suspended for good. The hook had suspended it, and its `visibilitychange` listener was the only thing that would resume it. That listener went with the same cleanup. Swapping the `controller` argument while hidden stranded the outgoing one the same way. The cleanup now resumes whichever controller it is the reason for suspending, and leaves a controller it never suspended alone.

The package README's API table now covers every export, grouped by what it is for. It listed 8 of them before.
