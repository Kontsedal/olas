import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  platform: 'node',
  deps: { neverBundle: ['ts-morph'] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // The bin's `#!/usr/bin/env node` is the first line of `src/cli.ts`, which
  // rolldown keeps. tsdown's `banner` cannot target one chunk: 0.22 caches the
  // first result of a banner function and reuses it for every chunk.
})
