<script setup lang="ts">
import { VPButton } from 'vitepress/theme-without-fonts'
import TwoTrees from './TwoTrees.vue'
</script>

<template>
  <section class="home-hero">
    <div class="inner">
      <div class="copy">
        <h1>App logic that lives outside your components</h1>
        <p class="lede">
          Olas keeps the fetching, the state and the rules of each screen in controllers: plain
          TypeScript functions. React, Vue or Svelte draws what a controller exposes, and a test
          runs it with no renderer.
        </p>
        <div class="actions">
          <VPButton tag="a" size="big" theme="brand" text="Get started" href="/guide/getting-started" />
          <VPButton tag="a" size="big" theme="alt" text="What is Olas?" href="/guide/what-is-olas" />
        </div>
      </div>
      <TwoTrees class="diagram" />
    </div>
  </section>
</template>

<style scoped>
.home-hero {
  padding: 56px 24px 24px;
}

/* One column until the diagram fits beside the copy. `minmax(0, 1fr)` lets
   the column shrink below the diagram's min-content width, so a narrow
   screen never scrolls sideways. */
.inner {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 40px;
  max-width: 1152px;
  margin: 0 auto;
}

h1 {
  max-width: 13em;
  margin: 0;
  font-size: clamp(36px, 5.2vw, 56px);
  font-weight: 750;
  line-height: 1.06;
  letter-spacing: -0.028em;
  text-wrap: balance;
  color: var(--vp-c-text-1);
}

.lede {
  max-width: 34em;
  margin: 20px 0 0;
  font-size: 19px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.diagram {
  width: 100%;
  max-width: 520px;
}

@media (min-width: 640px) {
  .home-hero {
    padding: 72px 48px 32px;
  }
}

@media (min-width: 960px) {
  .home-hero {
    padding: 96px 64px 48px;
  }

  .inner {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 56px;
  }

  .diagram {
    width: 480px;
  }
}
</style>
