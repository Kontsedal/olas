import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  platform: 'node',
  deps: { neverBundle: ['eslint', '@typescript-eslint/utils'] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
