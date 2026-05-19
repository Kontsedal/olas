import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  deps: { neverBundle: ['react', '@olas/core', '@olas/react'] },
  outExtensions: ({ format }) => ({ js: format === 'es' ? '.mjs' : '.cjs' }),
})
