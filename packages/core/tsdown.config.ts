import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
