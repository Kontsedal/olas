<script lang="ts">
import type { InfiniteQuerySubscription } from '@kontsedal/olas-core'
import { getRoot, infiniteQueryStore } from '../../src'

const api = getRoot<{ feed: InfiniteQuerySubscription<number[], number> }>()
const feed = infiniteQueryStore(api.feed)
</script>

<p>{$feed.flat.join(',')}|{$feed.hasNextPage}|{$feed.isFetchingNextPage}</p>
<button onclick={() => feed.fetchNextPage()}>more</button>
