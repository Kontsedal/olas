import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  deps: { neverBundle: ['@kontsedal/olas-core', 'zod'] },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
