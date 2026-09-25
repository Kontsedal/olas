// Build-time fix for the published `index.d.ts`.
//
// rolldown-plugin-dts (0.28.2+, under tsdown 0.23) writes each export inline,
// as `export declare function …`, and drops the trailing `export { … }` list.
// TypeScript treats a declaration file with no export list as an export
// context, where every top-level declaration is exported. Here that exports
// the private `BRAND` and `PHANTOM` symbols from `src/index.ts`, which have no
// runtime value. An empty `export {}` turns the export context off, and the
// file exports what the source exports. `etc/olas-entities.api.md` shows any
// leak as two new public symbols.

type OutputChunk = { type: 'chunk'; fileName: string; code: string }
type OutputAsset = { type: 'asset' }

const EXPORT_LIST = /^export (type )?\{/m
const MAP_COMMENT = /\n\/\/# sourceMappingURL=[^\n]*\n?$/

/** A rolldown plugin that appends `export {}` to a `.d.ts` chunk without an export list. */
export function dtsExportMarker(): {
  name: string
  generateBundle(options: unknown, bundle: Record<string, OutputChunk | OutputAsset>): void
} {
  return {
    name: 'olas-entities:dts-export-marker',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.fileName.endsWith('.d.ts')) continue
        if (EXPORT_LIST.test(chunk.code)) continue
        const map = MAP_COMMENT.exec(chunk.code)
        // Appended after the last line, so the declaration map stays accurate.
        chunk.code = map
          ? `${chunk.code.slice(0, map.index)}\nexport {}${chunk.code.slice(map.index)}`
          : `${chunk.code}\nexport {}\n`
      }
    },
  }
}
