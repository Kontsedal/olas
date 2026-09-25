---
"@kontsedal/olas-core": patch
---

**A shift-click with a `Map` index selects by the index values, not by the order the `Map` was filled in.**

`handleClick(id, { shift: true }, index)` collected the ids at insertion positions between the two ends. A `Map` filled in id order but valued by display order selected the wrong rows: display order `c, a, b, d`, a click on `c` and a shift-click on `a` selected `c, a, b`. The range is now every id whose index lies between the two ends.
