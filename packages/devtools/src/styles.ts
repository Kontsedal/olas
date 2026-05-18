/**
 * Inline CSS for the devtools panel. Scoped to the `.olas-devtools-*` class
 * prefix so it doesn't bleed into the host app. Honors `prefers-color-scheme`
 * and accepts host palette overrides via `--olas-*` custom properties.
 */
export const DEVTOOLS_CSS = `
.olas-devtools {
  --olas-bg: #ffffff;
  --olas-fg: #1f2330;
  --olas-muted: #6b7280;
  --olas-soft: #f5f6f9;
  --olas-accent: #4f46e5;
  --olas-accent-soft: rgba(79,70,229,0.10);
  --olas-success: #2a9d3a;
  --olas-success-soft: rgba(42,157,58,0.12);
  --olas-warn: #b45309;
  --olas-warn-soft: rgba(180,83,9,0.12);
  --olas-error: #c84141;
  --olas-error-soft: rgba(200,65,65,0.12);
  --olas-border: #e6e6ea;
  --olas-row-alt: #fafafc;

  font-family: ui-sans-serif, system-ui, -apple-system, "Inter", "Segoe UI", sans-serif;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--olas-fg);
  background: var(--olas-bg);
  border: 1px solid var(--olas-border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 320px;
  overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .olas-devtools {
    --olas-bg: #1b1d24;
    --olas-fg: #e6e8ee;
    --olas-muted: #98a0b3;
    --olas-soft: #232631;
    --olas-accent: #8b86f0;
    --olas-accent-soft: rgba(139,134,240,0.16);
    --olas-success: #4ade80;
    --olas-success-soft: rgba(74,222,128,0.16);
    --olas-warn: #f59e0b;
    --olas-warn-soft: rgba(245,158,11,0.16);
    --olas-error: #ef4444;
    --olas-error-soft: rgba(239,68,68,0.16);
    --olas-border: #2c2f3a;
    --olas-row-alt: #1e2129;
  }
}

/* ---- tabs ------------------------------------------------------------- */
.olas-devtools-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  border-bottom: 1px solid var(--olas-border);
  background: var(--olas-soft);
  padding: 4px 6px;
}
.olas-devtools-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: transparent;
  color: var(--olas-muted);
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  font-size: 12px;
  transition: background 80ms, color 80ms;
}
.olas-devtools-tab:hover {
  color: var(--olas-fg);
  background: color-mix(in oklch, var(--olas-bg) 60%, transparent);
}
.olas-devtools-tab[aria-selected="true"] {
  color: var(--olas-fg);
  background: var(--olas-bg);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
}
.olas-devtools-tab[aria-selected="true"] .olas-devtools-tab-count {
  background: var(--olas-accent);
  color: white;
}
.olas-devtools-tab-count {
  min-width: 16px;
  padding: 0 5px;
  height: 16px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--olas-fg) 12%, transparent);
  color: var(--olas-muted);
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.olas-devtools-pause,
.olas-devtools-clear {
  padding: 5px 10px;
  background: transparent;
  color: var(--olas-muted);
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
}
.olas-devtools-pause { margin-left: auto; }
.olas-devtools-pause:hover,
.olas-devtools-clear:hover {
  color: var(--olas-fg);
  background: color-mix(in oklch, var(--olas-bg) 60%, transparent);
}
.olas-devtools-pause-on {
  color: var(--olas-warn);
  background: var(--olas-warn-soft);
}
.olas-devtools-pause-on:hover { color: var(--olas-warn); }

/* ---- filter input ---------------------------------------------------- */
.olas-devtools-filter {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--olas-border);
  background: color-mix(in oklch, var(--olas-soft) 70%, transparent);
}
.olas-devtools-filter input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--olas-border);
  border-radius: 5px;
  background: var(--olas-bg);
  color: var(--olas-fg);
  font: inherit;
  font-size: 11.5px;
  outline: none;
}
.olas-devtools-filter input:focus { border-color: var(--olas-accent); }
.olas-devtools-filter input::placeholder { color: var(--olas-muted); }
.olas-devtools-filter button {
  background: transparent;
  border: 0;
  color: var(--olas-muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 2px 6px;
}
.olas-devtools-filter button:hover { color: var(--olas-fg); }

/* ---- body ------------------------------------------------------------- */
.olas-devtools-body {
  flex: 1;
  overflow: auto;
}

/* ---- list rows ------------------------------------------------------- */
.olas-devtools-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.olas-devtools-list li {
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in oklch, var(--olas-border) 70%, transparent);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background 60ms;
}
.olas-devtools-list li:hover { background: var(--olas-row-alt); }
.olas-devtools-row-clickable { cursor: pointer; }
.olas-devtools-row-clickable:hover { background: var(--olas-accent-soft); }
.olas-devtools-duration {
  color: var(--olas-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  background: var(--olas-soft);
  border-radius: 4px;
  padding: 0 6px;
  line-height: 1.4;
  white-space: nowrap;
}

.olas-devtools-row-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.olas-devtools-target {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--olas-fg);
  word-break: break-word;
}
.olas-devtools-target strong {
  font-weight: 600;
  color: var(--olas-accent);
}
.olas-devtools-time {
  color: var(--olas-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.olas-devtools-kind {
  color: var(--olas-accent);
  background: var(--olas-accent-soft);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  line-height: 1.3;
}
.olas-devtools-kind-success { color: var(--olas-success); background: var(--olas-success-soft); }
.olas-devtools-kind-error   { color: var(--olas-error);   background: var(--olas-error-soft); }
.olas-devtools-kind-warn,
.olas-devtools-kind-rollback { color: var(--olas-warn); background: var(--olas-warn-soft); }
.olas-devtools-payload {
  margin-left: 6px;
  padding: 4px 8px;
  background: var(--olas-soft);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--olas-muted);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- empty state ---------------------------------------------------- */
.olas-devtools-empty {
  padding: 32px 24px;
  text-align: center;
  color: var(--olas-muted);
}
.olas-devtools-empty-title {
  color: var(--olas-fg);
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.olas-devtools-empty-hint {
  font-size: 11.5px;
  max-width: 320px;
  margin: 0 auto;
}

/* ---- tree --------------------------------------------------------- */
.olas-devtools-tree { padding: 10px 12px; }
.olas-devtools-tree-node {
  padding: 2px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.olas-devtools-tree-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.olas-devtools-tree-name { color: var(--olas-fg); font-weight: 500; }
.olas-devtools-tree-state-active {
  color: var(--olas-success);
  background: var(--olas-success-soft);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.olas-devtools-tree-state-suspended {
  color: var(--olas-warn);
  background: var(--olas-warn-soft);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.olas-devtools-tree-state-disposed {
  color: var(--olas-muted);
  background: color-mix(in oklch, var(--olas-fg) 8%, transparent);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.olas-devtools-tree-children {
  margin-left: 12px;
  border-left: 1px dashed color-mix(in oklch, var(--olas-border) 80%, var(--olas-muted) 20%);
  padding-left: 12px;
  margin-top: 2px;
}
`
