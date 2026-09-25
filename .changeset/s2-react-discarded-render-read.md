---
"@kontsedal/olas-react": patch
---

**A `useQuery` result read after commit stays live when React throws a later render away.**

The fine-grained `useQuery` and `useInfiniteQuery` return getters that give the rendered snapshot during render and the live value afterwards. They told the two apart by a flag each render set and each commit cleared. A render that never commits, such as a transition whose sibling suspends, left the flag set. The committed result then kept returning its rendered values, so a field the component never read in render was read stale from an event handler or an effect. The hooks now count commits instead, and a discarded render cannot hold the count.
