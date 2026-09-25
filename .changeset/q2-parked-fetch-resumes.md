---
"@kontsedal/olas-core": patch
---

**A fetch parked for the network runs once the network is back, even when the `online` event is missed.**

The interval, focus and reconnect triggers skipped a parked entry and left it to the `online` event. A worker has no `window` to fire that event, and a browser can fire it while `navigator.onLine` still reads false, so the entry stayed parked with `isPaused: true` for good. These triggers now run the parked fetch when they find the network back. While offline they still start nothing, and one `online` event still makes one request.
