/**
 * `refetch()` was called on a subscription whose `enabled` is `false`. A
 * disabled subscription has no entry to fetch; its key may not even be
 * computable yet. Filter this error, or disable the control while
 * `subscription.isEnabled.value` is `false`.
 */
export class QueryDisabledError extends Error {
  /** The query's `id`. */
  readonly queryId: string

  constructor(queryId: string) {
    super(
      `[olas] refetch() on query '${queryId}' while its subscription is disabled — nothing ` +
        'was fetched. Check `isEnabled` before refetching.',
    )
    this.name = 'QueryDisabledError'
    this.queryId = queryId
  }
}
