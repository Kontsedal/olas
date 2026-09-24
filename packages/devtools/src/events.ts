// Per-event display helpers, shared by the timeline and the search index.

import type { DebugEvent } from '@kontsedal/olas-core'
import { formatPath } from './format'
import { toSearchText } from './util'

/** The lane a timeline event belongs to: `core`, or `plugin:<name>` for `host.debug` events. */
export function laneOf(ev: DebugEvent): string {
  return ev.type === 'plugin:event' ? `plugin:${ev.plugin}` : 'core'
}

/** A compact target string for an event: controller path, query key, field, or plugin payload. */
export function eventTarget(ev: DebugEvent): string {
  switch (ev.type) {
    case 'controller:constructed':
    case 'controller:suspended':
    case 'controller:resumed':
    case 'controller:disposed':
    case 'controller:debug':
      return formatPath(ev.path)
    case 'mutation:run':
    case 'mutation:success':
    case 'mutation:error':
    case 'mutation:rollback':
      return ev.name !== undefined ? `${ev.name} · ${formatPath(ev.path)}` : formatPath(ev.path)
    case 'field:validated':
      return `${formatPath(ev.path)} · ${ev.field}`
    case 'plugin:event':
      return toSearchText(ev.payload, 120)
    default:
      // The remaining variants (cache:* / snapshot:*) carry a queryKey. The
      // guard keeps an event type from a newer core from crashing the row.
      return 'queryKey' in ev ? formatPath(ev.queryKey) : ''
  }
}

/** The payload to reveal on expand, for non-`set-data` events (undefined = no detail). */
export function eventPayload(ev: DebugEvent): unknown {
  switch (ev.type) {
    case 'controller:constructed':
      return ev.props
    case 'mutation:run':
      return ev.vars
    case 'mutation:success':
      return ev.result
    case 'mutation:error':
    case 'cache:fetch-error':
      return ev.error
    case 'plugin:event':
      return ev.payload
    default:
      return undefined
  }
}

/**
 * Short badge text. A plugin event's badge is the plugin's name, so each row
 * says which lane it came from. Everything else drops its `family:` prefix
 * (snapshot is kept as `snap:`).
 */
export function badgeLabel(ev: DebugEvent): string {
  if (ev.type === 'plugin:event') return ev.plugin
  if (ev.type.startsWith('snapshot:')) return ev.type.replace('snapshot:', 'snap:')
  return ev.type.slice(ev.type.indexOf(':') + 1)
}

export function timelineKindClass(type: DebugEvent['type']): string {
  if (type === 'mutation:error' || type === 'cache:fetch-error') return 'olas-devtools-kind-error'
  if (type === 'mutation:rollback' || type === 'snapshot:rollback') {
    return 'olas-devtools-kind-rollback'
  }
  if (type === 'mutation:success' || type === 'cache:fetch-success') {
    return 'olas-devtools-kind-success'
  }
  if (
    type === 'cache:invalidated' ||
    type === 'cache:gc' ||
    type === 'controller:disposed' ||
    type === 'controller:suspended'
  ) {
    return 'olas-devtools-kind-warn'
  }
  return ''
}
