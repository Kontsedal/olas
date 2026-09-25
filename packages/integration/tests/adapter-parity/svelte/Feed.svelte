<script lang="ts">
import { getRoot, infiniteQueryStore } from '@kontsedal/olas-svelte'
import type { FeedApi } from '../scenarios'

const feed = infiniteQueryStore(getRoot<FeedApi>().feed)
</script>

<p data-testid="feed">{$feed.flat.join(',')}|{$feed.hasNextPage}</p>
<button type="button" data-testid="more" onclick={() => void feed.fetchNextPage()}>more</button>
