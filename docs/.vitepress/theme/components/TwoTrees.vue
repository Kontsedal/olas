<script setup lang="ts">
// The two trees from the Concepts page, drawn once for the home page and the
// guide. The rows line up across the three columns, so a link is a straight
// line from a component to the controller it reads. The headers share one
// grid row, so a header that wraps on a phone moves both trees together.
type Row = { label: string; depth: number; last?: boolean; note?: string; kind?: 'primitive' }

const components: Row[] = [
  { label: 'App', depth: 0 },
  { label: 'Toolbar', depth: 1 },
  { label: 'BoardPage', depth: 1, last: true },
]

const controllers: Row[] = [
  { label: 'app', depth: 0, note: 'root' },
  { label: 'toolbar', depth: 1 },
  { label: 'board', depth: 1, last: true },
  { label: 'createQuery', depth: 2, kind: 'primitive' },
  { label: 'createMutation', depth: 2, kind: 'primitive' },
  { label: 'cardEditor', depth: 2, last: true, note: 'while open' },
]

// Index in the rows above → the adapter call that reads it.
const links = new Map([
  [1, 'useValue'],
  [2, 'useQuery'],
])
</script>

<template>
  <figure class="two-trees">
    <div class="columns">
      <div class="column view">
        <div class="head">
          <p class="title">Components</p>
          <p class="role">draw what they read</p>
        </div>
        <ul class="tree">
          <li
            v-for="row in components"
            :key="row.label"
            :class="{ child: row.depth > 0, last: row.last }"
            :style="{ '--depth': row.depth }"
          >
            {{ row.label }}
          </li>
        </ul>
      </div>

      <div class="column links" aria-hidden="true">
        <ul class="tree">
          <li v-for="(_, i) in controllers" :key="i">
            <span v-if="links.has(i)" class="link">{{ links.get(i) }}</span>
          </li>
        </ul>
      </div>

      <div class="column logic">
        <div class="head">
          <p class="title">Controllers</p>
          <p class="role">own the state and logic</p>
        </div>
        <ul class="tree">
          <li
            v-for="row in controllers"
            :key="row.label"
            :class="{ child: row.depth > 0, last: row.last, primitive: row.kind === 'primitive' }"
            :style="{ '--depth': row.depth }"
          >
            {{ row.label }}<span v-if="row.note" class="note">{{ row.note }}</span>
          </li>
        </ul>
      </div>
    </div>
    <figcaption>
      Components read a controller's signals through the adapter. Controllers import no
      component, so they run and test on their own.
    </figcaption>
  </figure>
</template>

<style scoped>
.two-trees {
  --row: 34px;
  --indent: 18px;
  margin: 0;
  padding: 20px 24px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-alt);
}

.columns {
  display: grid;
  grid-template-columns: auto minmax(64px, 1fr) auto;
  grid-template-rows: auto auto;
}

/* Each column's header and tree are placed on the shared grid directly. */
.column {
  display: contents;
}

.head {
  grid-row: 1;
  padding-bottom: 10px;
}

.view > * {
  grid-column: 1;
}

.links > * {
  grid-column: 2;
}

.logic > * {
  grid-column: 3;
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  line-height: 22px;
  color: var(--vp-c-text-1);
}

.role {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--vp-c-text-2);
}

.tree {
  grid-row: 2;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tree li {
  position: relative;
  height: var(--row);
  padding-left: calc(var(--depth, 0) * var(--indent));
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  line-height: var(--row);
  white-space: nowrap;
  color: var(--vp-c-text-1);
}

/* The elbow joining a node to its parent: a vertical stroke down the
   parent's indent, then a stub across to the label. */
.tree li.child::before,
.tree li.child::after {
  content: '';
  position: absolute;
  left: calc((var(--depth) - 1) * var(--indent) + 5px);
  border-color: var(--vp-c-border);
  border-style: solid;
  border-width: 0;
}

.tree li.child::before {
  top: 0;
  bottom: 0;
  border-left-width: 1px;
}

.tree li.child.last::before {
  bottom: 50%;
}

.tree li.child::after {
  top: 50%;
  width: 8px;
  border-top-width: 1px;
}

.tree li.primitive {
  color: var(--vp-c-text-2);
}

.note {
  margin-left: 8px;
  font-family: var(--vp-font-family-base);
  font-size: 12px;
  color: var(--vp-c-text-2);
}

/* The one coupling between the trees, and the one place the accent goes. */
.links .tree li {
  padding: 0 10px;
}

.link {
  position: relative;
  display: block;
  height: 100%;
  font-size: 12px;
  /* The label sits in the upper half of the row, above the stroke. */
  line-height: calc(var(--row) / 2 - 2px);
  text-align: center;
  color: var(--vp-c-brand-1);
}

.link::before {
  content: '';
  position: absolute;
  left: 0;
  right: 4px;
  top: 50%;
  border-top: 1.5px solid currentColor;
}

.link::after {
  content: '';
  position: absolute;
  right: 0;
  top: calc(50% - 4px);
  border-left: 7px solid currentColor;
  border-top: 4.5px solid transparent;
  border-bottom: 4.5px solid transparent;
}

figcaption {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 14px;
  line-height: 22px;
  color: var(--vp-c-text-2);
}

@media (max-width: 520px) {
  .two-trees {
    --row: 30px;
    --indent: 14px;
    padding: 16px 14px 14px;
  }

  .tree li {
    font-size: 12.5px;
  }

  .links .tree li {
    padding: 0 6px;
  }

  .link {
    font-size: 11px;
  }

  .note {
    display: none;
  }
}
</style>
