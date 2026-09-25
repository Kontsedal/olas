---
"@kontsedal/olas-core": patch
---

**A fetch requested offline supersedes the one in flight, and reconnect makes one request.** In `online` mode, a fetch requested while offline parked without superseding the fetch already running, so that older response still landed: a local cache whose key changed offline showed the old key's data. It now supersedes it first, as a request made online does. An interval tick or a focus or reconnect refetch now skips an entry whose fetch is parked. Each tick used to park one more waiter, and with `refetchOnReconnect` one `online` event started two requests and aborted the first.
