/**
 * Inline CSS for the devtools panel. Scoped to the `.olas-devtools-*` class
 * prefix so it doesn't bleed into the host app. Honors `prefers-color-scheme`
 * and accepts host palette overrides via `--olas-*` custom properties.
 */
export const DEVTOOLS_CSS = `
.olas-devtools {
  container-type: inline-size;
  --olas-bg:           #ffffff;
  --olas-fg:           #1f2330;
  --olas-muted:        #6b7280;
  --olas-soft:         #f5f6f9;
  --olas-soft-2:       #eef0f4;
  --olas-accent:       #4f46e5;
  --olas-accent-soft:  rgba(79,70,229,0.10);
  --olas-success:      #1e8a3d;
  --olas-success-soft: rgba(30,138,61,0.12);
  --olas-warn:         #ad6800;
  --olas-warn-soft:    rgba(173,104,0,0.12);
  --olas-error:        #b8361f;
  --olas-error-soft:   rgba(184,54,31,0.12);
  --olas-border:       #e6e6ea;
  --olas-border-soft:  #eeeef2;
  --olas-row-alt:      #fafafc;

  /* JSON viewer colors */
  --olas-json-key:     #7a4ab8;
  --olas-json-string:  #1e8a3d;
  --olas-json-number:  #b25400;
  --olas-json-boolean: #4f46e5;
  --olas-json-null:    #9aa0aa;
  --olas-json-bracket: #6b7280;
  --olas-json-summary: #6b7280;

  font-family: -apple-system, BlinkMacSystemFont, "Inter var", "Inter", "Segoe UI", system-ui, sans-serif;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--olas-fg);
  background: var(--olas-bg);
  border: 1px solid var(--olas-border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 320px;
  overflow: hidden;
  box-sizing: border-box;
}
.olas-devtools *,
.olas-devtools *::before,
.olas-devtools *::after { box-sizing: border-box; }

@media (prefers-color-scheme: dark) {
  .olas-devtools {
    --olas-bg:           #15171e;
    --olas-fg:           #e8ebf2;
    --olas-muted:        #97a0b3;
    --olas-soft:         #1d2029;
    --olas-soft-2:       #232733;
    --olas-accent:       #8b86f0;
    --olas-accent-soft:  rgba(139,134,240,0.18);
    --olas-success:      #4ade80;
    --olas-success-soft: rgba(74,222,128,0.16);
    --olas-warn:         #f5b740;
    --olas-warn-soft:    rgba(245,183,64,0.16);
    --olas-error:        #ef6b53;
    --olas-error-soft:   rgba(239,107,83,0.16);
    --olas-border:       #2a2e3a;
    --olas-border-soft:  #20232c;
    --olas-row-alt:      #1a1d25;

    --olas-json-key:     #c39bff;
    --olas-json-string:  #7ee79d;
    --olas-json-number:  #f5b740;
    --olas-json-boolean: #8b86f0;
    --olas-json-null:    #7c8090;
    --olas-json-bracket: #97a0b3;
    --olas-json-summary: #97a0b3;
  }
}

/* ---- tabs ------------------------------------------------------------- */
.olas-devtools-tabs {
  display: flex;
  align-items: center;
  gap: 1px;
  border-bottom: 1px solid var(--olas-border);
  background: var(--olas-soft);
  padding: 0 8px;
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.olas-devtools-tabs::-webkit-scrollbar { display: none; }
.olas-devtools-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 8px;
  background: transparent;
  color: var(--olas-muted);
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 80ms, border-color 80ms;
}
.olas-devtools-tab-label-full { display: inline; }
.olas-devtools-tab-label-short { display: none; }
@container (max-width: 480px) {
  .olas-devtools-tab { padding: 9px 8px 8px; font-size: 11.5px; gap: 4px; }
  .olas-devtools-tab-label-full { display: none; }
  .olas-devtools-tab-label-short { display: inline; }
  .olas-devtools-pause-text,
  .olas-devtools-clear-text { display: none; }
}
.olas-devtools-tab:hover { color: var(--olas-fg); }
.olas-devtools-tab[aria-selected="true"] {
  color: var(--olas-fg);
  border-bottom-color: var(--olas-accent);
}
.olas-devtools-tab[aria-selected="true"] .olas-devtools-tab-count {
  background: var(--olas-accent-soft);
  color: var(--olas-accent);
}
.olas-devtools-tab-count {
  min-width: 18px;
  padding: 0 6px;
  height: 16px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--olas-fg) 8%, transparent);
  color: var(--olas-muted);
  font-size: 10.5px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.olas-devtools-pause,
.olas-devtools-clear {
  padding: 4px 10px;
  background: transparent;
  color: var(--olas-muted);
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
  align-self: center;
}
.olas-devtools-pause { margin-left: auto; }
.olas-devtools-pause:hover,
.olas-devtools-clear:hover {
  color: var(--olas-fg);
  background: color-mix(in oklch, var(--olas-bg) 60%, transparent);
}
.olas-devtools-pause-on { color: var(--olas-warn); background: var(--olas-warn-soft); }
.olas-devtools-pause-on:hover { color: var(--olas-warn); }
.olas-devtools-clear-icon { display: none; }
@container (max-width: 480px) {
  .olas-devtools-clear-text { display: none; }
  .olas-devtools-clear-icon { display: inline; }
  .olas-devtools-pause, .olas-devtools-clear { padding: 4px 8px; }
}

/* ---- filter ---------------------------------------------------------- */
.olas-devtools-filter {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--olas-border-soft);
  background: var(--olas-bg);
}
.olas-devtools-filter input {
  flex: 1;
  padding: 5px 9px;
  border: 1px solid var(--olas-border);
  border-radius: 6px;
  background: var(--olas-soft);
  color: var(--olas-fg);
  font: inherit;
  font-size: 12px;
  outline: none;
  transition: border-color 80ms, box-shadow 80ms;
}
.olas-devtools-filter input:focus {
  border-color: var(--olas-accent);
  box-shadow: 0 0 0 2px var(--olas-accent-soft);
}
.olas-devtools-filter input::placeholder { color: var(--olas-muted); }
.olas-devtools-filter button {
  background: transparent;
  border: 0;
  color: var(--olas-muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  padding: 2px 6px;
}
.olas-devtools-filter button:hover { color: var(--olas-fg); }

/* ---- body ------------------------------------------------------------ */
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
  border-bottom: 1px solid var(--olas-border-soft);
  display: flex;
  flex-direction: column;
}
.olas-devtools-list li:last-child { border-bottom: none; }
.olas-devtools-list li:hover { background: var(--olas-row-alt); }

.olas-devtools-row-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  min-height: 32px;
}
.olas-devtools-row-clickable .olas-devtools-row-top { cursor: pointer; user-select: none; }

.olas-devtools-target {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--olas-fg);
  word-break: break-word;
  min-width: 0;
}
.olas-devtools-target strong { font-weight: 600; color: var(--olas-accent); }
.olas-devtools-time {
  color: var(--olas-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.olas-devtools-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--olas-muted);
  font-size: 12px;
  width: 16px;
  height: 16px;
  transition: transform 100ms;
  user-select: none;
}
.olas-devtools-chevron-open { transform: rotate(90deg); color: var(--olas-fg); }

.olas-devtools-kind {
  color: var(--olas-accent);
  background: var(--olas-accent-soft);
  border-radius: 4px;
  padding: 1px 7px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.olas-devtools-kind-success { color: var(--olas-success); background: var(--olas-success-soft); }
.olas-devtools-kind-error   { color: var(--olas-error);   background: var(--olas-error-soft); }
.olas-devtools-kind-warn,
.olas-devtools-kind-rollback { color: var(--olas-warn); background: var(--olas-warn-soft); }
.olas-devtools-duration {
  color: var(--olas-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  background: var(--olas-soft);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}

.olas-devtools-payload {
  margin: 0 12px 10px;
  padding: 8px 10px;
  background: var(--olas-soft);
  border: 1px solid var(--olas-border-soft);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: var(--olas-fg);
  overflow-x: auto;
}
.olas-devtools-payload-inline {
  margin-top: -4px;
  padding: 4px 10px;
  background: transparent;
  border: 0;
  color: var(--olas-muted);
  font-size: 11px;
}
.olas-devtools-payload-json { line-height: 1.5; }

/* ---- JSON viewer ----------------------------------------------------- */
.olas-devtools-json-row {
  display: block;
  padding-left: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}
.olas-devtools-json-children {
  display: block;
  border-left: 1px dashed var(--olas-border);
  margin-left: 4px;
}
.olas-devtools-json-block {
  display: inline-flex;
  flex-direction: column;
  vertical-align: top;
}
.olas-devtools-json-key {
  color: var(--olas-json-key);
  margin-right: 6px;
  font-weight: 500;
}
.olas-devtools-json-index {
  color: var(--olas-json-bracket);
  margin-right: 6px;
}
.olas-devtools-json-string { color: var(--olas-json-string); }
.olas-devtools-json-number { color: var(--olas-json-number); }
.olas-devtools-json-boolean { color: var(--olas-json-boolean); }
.olas-devtools-json-null { color: var(--olas-json-null); font-style: italic; }
.olas-devtools-json-bracket { color: var(--olas-json-bracket); }
.olas-devtools-json-error { color: var(--olas-error); }
.olas-devtools-json-summary {
  color: var(--olas-json-summary);
  font-style: italic;
  margin: 0 4px;
}
.olas-devtools-json-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0;
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.olas-devtools-json-toggle:hover { background: var(--olas-accent-soft); border-radius: 3px; }

/* ---- empty state ---------------------------------------------------- */
.olas-devtools-empty {
  padding: 36px 24px;
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
  font-size: 12px;
  max-width: 320px;
  margin: 0 auto;
  line-height: 1.55;
}

/* ---- tree ------------------------------------------------------------ */
.olas-devtools-tree { padding: 10px 12px; }
.olas-devtools-tree-node {
  padding: 1px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.olas-devtools-tree-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 1px 0;
}
.olas-devtools-tree-name { color: var(--olas-fg); font-weight: 500; }
.olas-devtools-tree-state-active,
.olas-devtools-tree-state-suspended,
.olas-devtools-tree-state-disposed {
  border-radius: 4px;
  padding: 0 6px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.olas-devtools-tree-state-active {
  color: var(--olas-success);
  background: var(--olas-success-soft);
}
.olas-devtools-tree-state-suspended {
  color: var(--olas-warn);
  background: var(--olas-warn-soft);
}
.olas-devtools-tree-state-disposed {
  color: var(--olas-muted);
  background: color-mix(in oklch, var(--olas-fg) 8%, transparent);
}
.olas-devtools-tree-pending {
  color: var(--olas-warn);
  background: var(--olas-warn-soft);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.olas-devtools-tree-props-toggle {
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--olas-muted);
  padding: 0 4px;
  border-radius: 4px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.olas-devtools-tree-props-toggle:hover {
  color: var(--olas-fg);
  background: var(--olas-soft);
}
.olas-devtools-tree-props {
  margin: 4px 0 6px 8px;
  padding: 6px 10px;
  background: var(--olas-soft);
  border: 1px solid var(--olas-border-soft);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  overflow-x: auto;
}
.olas-devtools-tree-children {
  margin-left: 8px;
  border-left: 1px dashed var(--olas-border);
  padding-left: 10px;
  margin-top: 2px;
}

/* ---- floating window + launcher ------------------------------------- */
.olas-devtools-launcher {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483645;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px 7px 11px;
  background: #1f2330;
  color: #e8ebf2;
  border: 1px solid #2a2e3a;
  border-radius: 999px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.15), 0 8px 24px rgba(0,0,0,0.18);
  cursor: pointer;
  font: inherit;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  font-size: 12px;
  font-weight: 500;
}
.olas-devtools-launcher:hover { filter: brightness(1.1); }
.olas-devtools-launcher-active { box-shadow: 0 0 0 2px rgba(139,134,240,0.5), 0 8px 24px rgba(0,0,0,0.18); }
.olas-devtools-launcher-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4ade80;
  box-shadow: 0 0 6px rgba(74,222,128,0.7);
}
.olas-devtools-launcher-label { letter-spacing: 0.01em; }

.olas-devtools-floating {
  position: fixed;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  background: var(--olas-bg, #ffffff);
  color: var(--olas-fg, #1f2330);
  border: 1px solid var(--olas-border, #e6e6ea);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18), 0 24px 64px rgba(0,0,0,0.18);
  overflow: hidden;
  /* Inherit the panel's own CSS vars when DevtoolsPanel is mounted inside. */
}
@media (prefers-color-scheme: dark) {
  .olas-devtools-floating {
    background: #15171e;
    color: #e8ebf2;
    border-color: #2a2e3a;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 24px 64px rgba(0,0,0,0.5);
  }
}
.olas-devtools-floating-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px 0 10px;
  background: var(--olas-soft, #f5f6f9);
  border-bottom: 1px solid var(--olas-border, #e6e6ea);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.olas-devtools-floating-header:active { cursor: grabbing; }
.olas-devtools-floating-grip {
  color: var(--olas-muted, #6b7280);
  font-size: 14px;
  line-height: 1;
}
.olas-devtools-floating-title {
  flex: 1;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--olas-fg, #1f2330);
  letter-spacing: 0.01em;
}
.olas-devtools-floating-actions { display: inline-flex; gap: 2px; }
.olas-devtools-floating-action {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--olas-muted, #6b7280);
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  line-height: 1;
}
.olas-devtools-floating-action:hover {
  color: var(--olas-fg, #1f2330);
  background: color-mix(in oklch, currentColor 14%, transparent);
}
.olas-devtools-floating-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.olas-devtools-floating-body > .olas-devtools {
  flex: 1;
  border: 0;
  border-radius: 0;
  min-height: 0;
}
.olas-devtools-floating-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  background:
    linear-gradient(135deg, transparent 0 7px, var(--olas-muted, #6b7280) 7px 8px, transparent 8px 10px,
                            var(--olas-muted, #6b7280) 10px 11px, transparent 11px 100%);
  opacity: 0.6;
}
.olas-devtools-floating-resize:hover { opacity: 1; }
`
