import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { specifierRef } from '../util/olas'

const PLUGIN =
  'the plugin contract is `definePlugin({ name, setup(host) })` in 1.0, with `OlasPlugin`, `PluginHost` and `WriteEvent`; see PLUGINS.md'

/** Core exports 1.0 removes, with what replaces each. */
export const REMOVED: ReadonlyMap<string, string> = new Map([
  ['QueryClientPlugin', PLUGIN],
  ['QueryClientPluginApi', PLUGIN],
  ['SetDataEvent', PLUGIN],
  ['InvalidateEvent', PLUGIN],
  ['GcEvent', PLUGIN],
  ['MutationEnqueueEvent', PLUGIN],
  ['MutationSettleEvent', PLUGIN],
  ['RegisteredQuery', PLUGIN],
  ['RegisteredMutation', PLUGIN],
  [
    'lookupRegisteredQuery',
    'internal in 1.0: a plugin reads a query through `host.queries.get(id)`',
  ],
  [
    'lookupRegisteredMutation',
    'internal in 1.0: a plugin runs a defined mutation with `host.mutations.run(id, vars)`',
  ],
  ['stableHash', 'internal in 1.0: a plugin hashes a key with `host.queries.hashKey(key)`'],
  ['isStandardSchema', 'no longer exported in 1.0'],
  ['ErrorContextInput', 'no longer exported in 1.0'],
])

/** Report every import of a core export 1.0 removes. Nothing is rewritten. */
export const removedApis: Transform = {
  name: 'removed-apis',
  description: 'reports imports of the removed plugin API, `stableHash` and the registry lookups',
  run: (files) =>
    runPerFile('removed-apis', files, (file, changes) => {
      for (const decl of file.getImportDeclarations()) {
        for (const spec of decl.getNamedImports()) {
          const ref = specifierRef(spec)
          if (ref?.pkg !== 'core') continue
          const reason = REMOVED.get(ref.name)
          if (reason !== undefined) changes.todo(spec, `\`${ref.name}\`: ${reason}`)
        }
      }
    }),
}
