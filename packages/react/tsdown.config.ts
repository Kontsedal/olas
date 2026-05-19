import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  deps: { neverBundle: ['react', '@kontsedal/olas-core'] },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  outExtensions: ({ format }) => ({ js: format === 'es' ? '.mjs' : '.cjs' }),
})
