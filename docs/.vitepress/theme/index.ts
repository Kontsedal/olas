import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource-variable/atkinson-hyperlegible-mono'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import { h } from 'vue'
import ForFramework from './components/ForFramework.vue'
import FrameworkPicker from './components/FrameworkPicker.vue'
import HomeHero from './components/HomeHero.vue'
import TwoTrees from './components/TwoTrees.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  // The home page has no `hero` frontmatter, so the default hero renders
  // nothing and this one takes its place.
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-before': () => h(HomeHero) }),
  enhanceApp({ app }) {
    app.component('FrameworkPicker', FrameworkPicker)
    app.component('ForFramework', ForFramework)
    app.component('TwoTrees', TwoTrees)
  },
} satisfies Theme
