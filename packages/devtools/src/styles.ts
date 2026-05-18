/**
 * Inline CSS for the devtools panel. Scoped to the `.olas-devtools-*` class
 * prefix so it doesn't bleed into the host app. Injected once per panel
 * instance via a `<style>` tag — no CSS-in-JS framework, no build-time
 * extraction needed.
 */
export const DEVTOOLS_CSS = `
.olas-devtools {
  --olas-bg: #1e1e1e;
  --olas-fg: #d4d4d4;
  --olas-muted: #8a8a8a;
  --olas-accent: #4ec9b0;
  --olas-warn: #ce9178;
  --olas-error: #f44747;
  --olas-border: #333;
  --olas-row: #252525;
  --olas-row-alt: #2a2a2a;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.4;
  color: var(--olas-fg);
  background: var(--olas-bg);
  border: 1px solid var(--olas-border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 320px;
  overflow: hidden;
}
.olas-devtools-tabs {
  display: flex;
  border-bottom: 1px solid var(--olas-border);
  background: var(--olas-row);
}
.olas-devtools-tab {
  padding: 6px 12px;
  background: transparent;
  color: var(--olas-muted);
  border: 0;
  border-right: 1px solid var(--olas-border);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font: inherit;
}
.olas-devtools-tab[aria-selected="true"] {
  color: var(--olas-fg);
  border-bottom-color: var(--olas-accent);
}
.olas-devtools-clear {
  margin-left: auto;
  padding: 6px 10px;
  background: transparent;
  color: var(--olas-muted);
  border: 0;
  cursor: pointer;
  font: inherit;
}
.olas-devtools-body {
  flex: 1;
  overflow: auto;
}
.olas-devtools-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.olas-devtools-list li {
  display: grid;
  grid-template-columns: 56px 80px 1fr;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--olas-border);
}
.olas-devtools-list li:nth-child(odd) {
  background: var(--olas-row-alt);
}
.olas-devtools-time {
  color: var(--olas-muted);
}
.olas-devtools-kind {
  color: var(--olas-accent);
}
.olas-devtools-kind-error {
  color: var(--olas-error);
}
.olas-devtools-kind-rollback {
  color: var(--olas-warn);
}
.olas-devtools-empty {
  padding: 16px;
  color: var(--olas-muted);
  text-align: center;
}
.olas-devtools-tree {
  padding: 8px;
}
.olas-devtools-tree-node {
  padding: 2px 0;
}
.olas-devtools-tree-name {
  color: var(--olas-fg);
}
.olas-devtools-tree-state-suspended {
  color: var(--olas-warn);
}
.olas-devtools-tree-state-disposed {
  color: var(--olas-muted);
  text-decoration: line-through;
}
.olas-devtools-tree-children {
  margin-left: 16px;
  border-left: 1px solid var(--olas-border);
  padding-left: 8px;
}
.olas-devtools-payload {
  white-space: pre-wrap;
  word-break: break-all;
}
`
