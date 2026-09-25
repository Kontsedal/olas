import { defineConfig, type UserConfig } from 'tsdown'

const shared: UserConfig = {
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  sourcemap: true,
  treeshake: true,
  target: 'es2022',
  deps: { neverBundle: ['@kontsedal/olas-core'] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
}

// Two builds from one source. `dist/` is the default export condition: a
// production build, with every `if (__DEV__)` branch (the devtools lane
// events) stripped. `dist/dev/` is the `development` condition, which Vite,
// webpack, Next and Rspack resolve in dev, so the devtools see the lane
// against the published package. tsdown cleans once, before both builds.
export default defineConfig([
  { ...shared, dts: true, clean: true, define: { __DEV__: 'false' } },
  { ...shared, outDir: 'dist/dev', dts: false, clean: false, define: { __DEV__: 'true' } },
])
