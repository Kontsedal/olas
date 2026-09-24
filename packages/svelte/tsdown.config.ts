import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  deps: { neverBundle: ['svelte', '@kontsedal/olas-core'] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
