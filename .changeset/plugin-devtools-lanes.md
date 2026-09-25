---
"@kontsedal/olas-cross-tab": minor
"@kontsedal/olas-entities": minor
---

**Cross-tab and entities report on their devtools lanes.** `@kontsedal/olas-devtools` shows one lane per plugin, and these two sent nothing on theirs.

- **cross-tab** reports each message it posts and each message a peer sent. An event names the direction, the message type, the query and key, the sender's `sourceId` and `msgId`, and what became of it. A send is `posted` or `not-cloneable`. A receive is `applied`, `duplicate`, `malformed`, `ignored`, `rejected` or `failed`. The sender's id and `msgId` name one message in both tabs' lanes.
- **entities** reports each `update`: the entity and id, how many query entries the patch reached and their query ids, and how many listed entries no longer held the entity.

The events are development-only. cross-tab now ships a development build behind the `development` export condition, like core and entities, and its default build strips the calls. That build grew by 10 B, from 1.31 kB to 1.32 kB brotlied.
