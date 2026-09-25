---
"@kontsedal/olas-core": patch
---

**Dehydrated keys now survive the JSON trip to the client.** `dehydrate` ships raw key args, and a key that JSON rewrites hashed differently after the trip, so the client never adopted the entry: it mounted `pending` and refetched, a hydration mismatch in React. A persisted cache had the same problem. A key now hashes as the value JSON round-trips it to. An `undefined` object member counts as absent, `undefined` in an array and a non-finite number as `null`, and a Date as its ISO string. `{ q: undefined }` and `{}` therefore name one cache entry, as a Date and its ISO string do. Every other value keeps its type tag.
