---
"@kontsedal/olas-devtools": patch
---

**`urlHashKey` leaves the app's own URL hash alone.**

The panel parsed the whole hash as URL parameters, re-encoded it and wrote it back. `#/users/42?tab=posts` became `#%2Fusers%2F42%3Ftab=posts&olas=…`, and `#section` became `#section=&olas=…`. The write also cleared the router's `history.state`.

The panel now keeps its state in one `key=value` segment. It writes only when the rest of the hash is empty or `key=value` pairs too, and those keep their exact bytes. It passes `history.state` through. It leaves a hash router's path or an anchor untouched, so there the panel state does not persist.
