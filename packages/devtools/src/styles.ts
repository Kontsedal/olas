/**
 * Inline CSS for the devtools panel. Scoped to the `.olas-devtools-*` class
 * prefix so it doesn't bleed into the host app. Honors `prefers-color-scheme`
 * and accepts host palette overrides via `--olas-*` custom properties.
 *
 * Every value here is picked by ROLE from a named step, never by eye — the
 * rules are in `.wiki/decisions/ui-rules.md`. The scales are the ones
 * `examples/_shared/ui/tokens.css` declares, carried here BY VALUE rather than
 * by import: this package ships its CSS inline in a string, so there is no
 * stylesheet for a host to pull a scale from. The duplication is deliberate.
 * Change one and change the other.
 *
 * The palette is solved, not sampled. Every foreground clears 4.5:1 against
 * all four surfaces, and --olas-border-control clears the 3:1 WCAG 1.4.11 asks
 * of an edge that is what identifies a control.
 */
export const DEVTOOLS_CSS = `
.olas-devtools,
.olas-devtools-launcher,
.olas-devtools-floating {
  /* Type, by role. Prose never drops below the meta step. */
  --olas-text-mark:   10px;  /* a chip, a badge, a count */
  --olas-text-chrome: 11px;  /* dense captions, mono rows */
  --olas-text-meta:   12px;  /* labels, inputs, empty states */
  --olas-text-body:   13px;  /* the default */
  --olas-text-title:  15px;  /* the floating window's title */

  /* Corners: three tiers, each naming a layer. */
  --olas-radius-surface: 8px;   /* the panel, the window, a bordered block */
  --olas-radius-control: 6px;   /* a field, a button, a tab */
  --olas-radius-mark:    4px;   /* a chip, a badge, a toggle */
  --olas-radius-pill:  999px;   /* a dot, a count */

  /* Motion: colour and opacity only, on a change the user caused. */
  --olas-motion-fast: 120ms;
  --olas-ease-out: cubic-bezier(0.16, 1, 0.3, 1);

  /* Elevation: an edge OR an elevation, never both. Only the launcher and the
     floating window take this; everything else takes a border. */
  --olas-shadow-float: 0 8px 24px oklch(0 0 0 / 0.12), 0 2px 6px oklch(0 0 0 / 0.06);

  /* The system stack. A panel docked in someone else's app should not arrive
     carrying a webfont, and should not insist on a typeface either. */
  --olas-font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --olas-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;

  /* Surfaces and edges. */
  --olas-bg:             oklch(1 0 0);
  --olas-soft:           oklch(0.945 0.006 240);
  --olas-soft-2:         oklch(0.925 0.008 240);
  --olas-row-alt:        oklch(0.978 0.004 240);
  --olas-border:         oklch(0.885 0.008 240);     /* a divider */
  --olas-border-soft:    oklch(0.93 0.006 240);    /* a fainter divider */
  --olas-border-control: oklch(0.6 0.012 240);   /* a control's own edge */

  /* Foreground tiers. Hierarchy is weight and position first; dimming is the
     last tool, and dim sits at 4.58:1 — the whole of its headroom. */
  --olas-fg:    oklch(0.24 0.02 240);
  --olas-muted: oklch(0.44 0.018 240);
  --olas-dim:   oklch(0.5 0.014 240);

  /* State. The accent means: this is what you chose, or what happens next. */
  --olas-accent:      oklch(0.49 0.083 196);
  --olas-accent-fg:   oklch(1 0 0);
  --olas-success:     oklch(0.49 0.129 152);
  --olas-warn:        oklch(0.51 0.108 75);
  --olas-error:       oklch(0.52 0.163 22);

  /* JSON syntax — categorical, because it separates KINDS of value inside one
     blob. Conventional hues, lightness solved to the same floor as the text. */
  --olas-json-key:     oklch(0.49 0.16 300);
  --olas-json-string:  oklch(0.49 0.129 152);
  --olas-json-number:  oklch(0.49 0.115 60);
  --olas-json-boolean: oklch(0.49 0.16 262);
  --olas-json-null:    var(--olas-dim);
  --olas-json-bracket: var(--olas-muted);
  --olas-json-summary: var(--olas-muted);
}

.olas-devtools {
  container-type: inline-size;
  font-family: var(--olas-font-ui);
  font-size: var(--olas-text-body);
  line-height: 1.5;
  color: var(--olas-fg);
  background: var(--olas-bg);
  border: 1px solid var(--olas-border);
  border-radius: var(--olas-radius-surface);
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
/* The panel takes focus on a click (tabindex -1) so the / shortcut can reach
   it; the panel is not a control, so the focus draws no ring. */
.olas-devtools:focus { outline: none; }

@media (prefers-color-scheme: dark) {
  .olas-devtools,
  .olas-devtools-launcher,
  .olas-devtools-floating {
    --olas-bg:             oklch(0.235 0.015 240);
    --olas-soft:           oklch(0.175 0.012 240);
    --olas-soft-2:         oklch(0.29 0.017 240);
    --olas-row-alt:        oklch(0.21 0.013 240);
    --olas-border:         oklch(0.335 0.015 240);
    --olas-border-soft:    oklch(0.29 0.013 240);
    --olas-border-control: oklch(0.585 0.012 240);

    --olas-fg:    oklch(0.95 0.004 240);
    --olas-muted: oklch(0.76 0.016 240);
    --olas-dim:   oklch(0.675 0.014 240);

    --olas-accent:      oklch(0.78 0.1 196);
    --olas-accent-fg:   oklch(0.16 0.02 196);
    --olas-success:     oklch(0.78 0.14 152);
    --olas-warn:        oklch(0.8 0.135 75);
    --olas-error:       oklch(0.74 0.15 22);

    --olas-json-key:     oklch(0.8 0.118 300);
    --olas-json-string:  oklch(0.78 0.15 152);
    --olas-json-number:  oklch(0.79 0.148 60);
    --olas-json-boolean: oklch(0.79 0.106 262);

    --olas-shadow-float: 0 8px 24px oklch(0 0 0 / 0.5), 0 2px 6px oklch(0 0 0 / 0.35);
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
  font-size: var(--olas-text-meta);
  white-space: nowrap;
  flex-shrink: 0;
  transition: color var(--olas-motion-fast), border-color var(--olas-motion-fast);
}
.olas-devtools-tab-label-full { display: inline; }
.olas-devtools-tab-label-short { display: none; }
@container (max-width: 480px) {
  .olas-devtools-tab { padding: 9px 8px 8px; font-size: var(--olas-text-chrome); gap: 4px; }
  .olas-devtools-tab-label-full { display: none; }
  .olas-devtools-tab-label-short { display: inline; }
  .olas-devtools-pause-text,
  .olas-devtools-clear-text { display: none; }
}
.olas-devtools-tab:hover { color: var(--olas-fg); }
/* One fact, one mark: the underline IS "this tab is open". The label
   brightening is readability, and the count badge stays neutral — a third
   copy of one fact in the same colour is decoration. */
.olas-devtools-tab[aria-selected="true"] {
  color: var(--olas-fg);
  border-bottom-color: var(--olas-accent);
}
.olas-devtools-tab-count {
  min-width: 18px;
  padding: 0 6px;
  height: 16px;
  border-radius: var(--olas-radius-pill);
  background: color-mix(in oklch, var(--olas-fg) 8%, transparent);
  color: var(--olas-muted);
  font-size: var(--olas-text-mark);
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
  border-radius: var(--olas-radius-control);
  cursor: pointer;
  font: inherit;
  font-size: var(--olas-text-chrome);
  align-self: center;
}
.olas-devtools-pause { margin-left: auto; }
.olas-devtools-pause:hover,
.olas-devtools-clear:hover {
  color: var(--olas-fg);
  background: color-mix(in oklch, var(--olas-bg) 60%, transparent);
}
.olas-devtools-pause-on { color: var(--olas-warn); background: var(--olas-soft-2); }
.olas-devtools-pause-on:hover { color: var(--olas-warn); }
.olas-devtools-clear-icon { display: none; }
@container (max-width: 480px) {
  .olas-devtools-clear-text { display: none; }
  .olas-devtools-clear-icon { display: inline; }
  .olas-devtools-pause, .olas-devtools-clear { padding: 4px 8px; }
}

/* ---- omnibox --------------------------------------------------------- */
.olas-devtools-omnibox {
  position: relative;
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--olas-border-soft);
  background: var(--olas-bg);
  flex-shrink: 0;
}
.olas-devtools-kbd {
  position: absolute;
  right: 18px;
  pointer-events: none;
  color: var(--olas-muted);
  border: 1px solid var(--olas-border-control);
  border-radius: var(--olas-radius-mark);
  padding: 0 6px;
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-mark);
  line-height: 1.4;
}
/* A popover floats, so it takes the elevation and no edge. */
.olas-devtools-omnibox-results {
  position: absolute;
  top: 100%;
  left: 10px;
  right: 10px;
  z-index: 3;
  max-height: 320px;
  overflow: auto;
  padding: 4px 0;
  background: var(--olas-bg);
  border-radius: var(--olas-radius-surface);
  box-shadow: var(--olas-shadow-float);
}
/* A heading above a group: capitals, no tracking. */
.olas-devtools-omnibox-group {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px 2px;
  color: var(--olas-muted);
  font-size: var(--olas-text-mark);
  font-weight: 600;
  text-transform: uppercase;
}
.olas-devtools-omnibox-total { font-variant-numeric: tabular-nums; }
.olas-devtools-omnibox-hit {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 12px;
  cursor: pointer;
  min-width: 0;
}
/* The active option is what Enter picks next. */
.olas-devtools-omnibox-hit[aria-selected="true"] { background: var(--olas-soft-2); }
.olas-devtools-omnibox-label,
.olas-devtools-omnibox-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-chrome);
}
.olas-devtools-omnibox-label { flex-shrink: 0; max-width: 55%; color: var(--olas-fg); }
.olas-devtools-omnibox-detail { flex: 1; min-width: 0; color: var(--olas-muted); }
.olas-devtools-omnibox-empty {
  padding: 8px 12px;
  color: var(--olas-muted);
  font-size: var(--olas-text-meta);
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
.olas-devtools-filter input,
.olas-devtools-omnibox input {
  flex: 1;
  padding: 5px 9px;
  border: 1px solid var(--olas-border);
  border-radius: var(--olas-radius-control);
  background: var(--olas-soft);
  color: var(--olas-fg);
  font: inherit;
  font-size: var(--olas-text-meta);
  outline: none;
  transition: border-color var(--olas-motion-fast), box-shadow var(--olas-motion-fast);
}
.olas-devtools-omnibox input { padding-right: 30px; }
.olas-devtools-filter input:focus,
.olas-devtools-omnibox input:focus {
  border-color: var(--olas-accent);
  outline: 2px solid var(--olas-accent);
  outline-offset: 1px;
}
.olas-devtools-filter input::placeholder,
.olas-devtools-omnibox input::placeholder { color: var(--olas-muted); }
.olas-devtools-filter button {
  background: transparent;
  border: 0;
  color: var(--olas-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--olas-text-body);
  padding: 2px 6px;
}
.olas-devtools-filter button:hover { color: var(--olas-fg); }

/* ---- body ------------------------------------------------------------ */
.olas-devtools-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
/* The windowed scroller. It fills the body and is the element that scrolls,
   so the list can mount only the rows in its viewport. */
.olas-devtools-vlist {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.olas-devtools-vlist:focus { outline: none; }
.olas-devtools-vlist:focus-visible { outline: 2px solid var(--olas-accent); outline-offset: -2px; }
/* A search jump's target: the row you chose. */
.olas-devtools-hit {
  outline: 2px solid var(--olas-accent);
  outline-offset: -2px;
  border-radius: var(--olas-radius-mark);
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
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-chrome);
  color: var(--olas-fg);
  word-break: break-word;
  min-width: 0;
}
.olas-devtools-target strong { font-weight: 600; color: var(--olas-accent); }
.olas-devtools-time {
  color: var(--olas-muted);
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-mark);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.olas-devtools-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--olas-muted);
  font-size: var(--olas-text-meta);
  width: 16px;
  height: 16px;
  transition: transform var(--olas-motion-fast);
  user-select: none;
}
.olas-devtools-chevron-open { transform: rotate(90deg); color: var(--olas-fg); }

/* A chip's ground was a 10-16% mix of its own text colour, which moves the
   ground toward the text by construction and spends the headroom the status
   tokens were solved to have. No ground; an edge in --olas-border-control,
   which is solved per theme to clear 3:1. */
.olas-devtools-kind {
  color: var(--olas-accent);
  border: 1px solid var(--olas-border-control);
  border-radius: var(--olas-radius-mark);
  padding: 0 6px;
  font-size: var(--olas-text-mark);
  font-weight: 600;
  white-space: nowrap;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.olas-devtools-kind-success { color: var(--olas-success); }
.olas-devtools-kind-error   { color: var(--olas-error); }
.olas-devtools-kind-warn,
.olas-devtools-kind-rollback { color: var(--olas-warn); }
.olas-devtools-duration {
  color: var(--olas-muted);
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-mark);
  font-variant-numeric: tabular-nums;
  background: var(--olas-soft);
  border-radius: var(--olas-radius-mark);
  padding: 1px 6px;
  white-space: nowrap;
}

.olas-devtools-payload {
  margin: 0 12px 10px;
  padding: 8px 10px;
  background: var(--olas-soft);
  border: 1px solid var(--olas-border-soft);
  border-radius: var(--olas-radius-control);
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-chrome);
  color: var(--olas-fg);
  overflow-x: auto;
}
.olas-devtools-payload-inline {
  margin-top: -4px;
  padding: 4px 10px;
  background: transparent;
  border: 0;
  color: var(--olas-muted);
  font-size: var(--olas-text-chrome);
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
/* A hover is not a state, so it does not spend the accent. The wash is also
   neutral because the label above it is a syntax colour, and a tint of an
   unknown hue behind it has no ratio anyone can check. */
.olas-devtools-json-toggle:hover { background: var(--olas-soft-2); border-radius: var(--olas-radius-mark); }

/* ---- empty state ---------------------------------------------------- */
.olas-devtools-empty {
  padding: 36px 24px;
  text-align: center;
  color: var(--olas-muted);
}
.olas-devtools-empty-title {
  color: var(--olas-fg);
  font-weight: 600;
  font-size: var(--olas-text-body);
  margin-bottom: 4px;
}
.olas-devtools-empty-hint {
  font-size: var(--olas-text-meta);
  max-width: 320px;
  margin: 0 auto;
  line-height: 1.55;
}

/* ---- tree ------------------------------------------------------------ */
.olas-devtools-tree { padding: 0 12px; }
/* One row per visible node. The indent guides are per-level spans that line
   up across rows, so the flattened list still draws its nesting. */
.olas-devtools-tree-item {
  display: flex;
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-meta);
}
.olas-devtools-tree-indent {
  flex: 0 0 auto;
  width: 10px;
  margin-left: 8px;
  border-left: 1px dashed var(--olas-border);
}
.olas-devtools-tree-content { flex: 1; min-width: 0; padding: 1px 0; }
.olas-devtools-tree-toggle {
  display: inline-flex;
  padding: 0;
  border: 0;
  border-radius: var(--olas-radius-mark);
  background: transparent;
  cursor: pointer;
  font: inherit;
}
.olas-devtools-tree-toggle:hover { background: var(--olas-soft-2); }
.olas-devtools-tree-leaf { display: inline-block; width: 16px; }
/* A disposed node is kept for a while, greyed: its name and every value in it
   drop to the dim tier, which is solved to clear 4.5:1 on its own. */
.olas-devtools-tree-item-disposed {
  --olas-json-key: var(--olas-dim);
  --olas-json-string: var(--olas-dim);
  --olas-json-number: var(--olas-dim);
  --olas-json-boolean: var(--olas-dim);
}
.olas-devtools-tree-item-disposed .olas-devtools-tree-name { color: var(--olas-dim); }
.olas-devtools-tree-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 1px 0;
}
.olas-devtools-tree-name { color: var(--olas-fg); font-weight: 500; }
/* Small caps inside a bordered chip is a legitimate element rather than a
   shouted heading, so the case stays. The letter-spacing goes: caps plus
   tracking, used as the default treatment for every small label, is the
   cliche this codebase does not spend. */
.olas-devtools-tree-state-active,
.olas-devtools-tree-state-suspended,
.olas-devtools-tree-state-disposed,
.olas-devtools-tree-pending {
  border: 1px solid var(--olas-border-control);
  border-radius: var(--olas-radius-mark);
  padding: 0 5px;
  font-size: var(--olas-text-mark);
  font-weight: 600;
  text-transform: uppercase;
}
.olas-devtools-tree-state-active { color: var(--olas-success); }
.olas-devtools-tree-state-suspended { color: var(--olas-warn); }
.olas-devtools-tree-state-disposed { color: var(--olas-dim); }
.olas-devtools-tree-pending { color: var(--olas-warn); }
.olas-devtools-tree-props-toggle {
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-chrome);
  color: var(--olas-muted);
  padding: 0 4px;
  border-radius: var(--olas-radius-mark);
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
  border-radius: var(--olas-radius-control);
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-chrome);
  overflow-x: auto;
}

/* ---- controller variables (ctx.debug) -------------------------------- */
.olas-devtools-tree-vars-toggle {
  background: transparent;
  color: var(--olas-accent);
  border: 1px solid var(--olas-border-control);
  border-radius: var(--olas-radius-mark);
  padding: 0 5px;
  font: inherit;
  font-size: var(--olas-text-mark);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--olas-motion-fast) var(--olas-ease-out);
}
.olas-devtools-tree-vars-toggle:hover { background: var(--olas-soft-2); }
.olas-devtools-tree-vars {
  margin: 4px 0 6px 8px;
  padding: 6px 10px;
  background: var(--olas-soft);
  border: 1px solid var(--olas-border-soft);
  border-radius: var(--olas-radius-control);
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-chrome);
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-x: auto;
}
.olas-devtools-var-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
.olas-devtools-var-name {
  color: var(--olas-json-key);
  font-weight: 600;
  flex-shrink: 0;
}
.olas-devtools-var-value { min-width: 0; }

/* ---- timeline -------------------------------------------------------- */
.olas-devtools-timeline { padding: 0 8px; }
.olas-devtools-tl-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--olas-border-soft);
  flex-shrink: 0;
}
.olas-devtools-lanes { display: flex; flex-wrap: wrap; gap: 4px; }
.olas-devtools-lane {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  background: transparent;
  color: var(--olas-fg);
  border: 1px solid var(--olas-border-control);
  border-radius: var(--olas-radius-mark);
  cursor: pointer;
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-mark);
  line-height: 1.6;
}
.olas-devtools-lane:hover { background: var(--olas-soft-2); }
/* One mark for a hidden lane: the strike. */
.olas-devtools-lane[aria-pressed="false"] { text-decoration: line-through; }
.olas-devtools-lane-count { color: var(--olas-muted); font-variant-numeric: tabular-nums; }
/* Events lost to the ring buffer's bound are a warning, not a failure. */
.olas-devtools-dropped {
  margin-left: auto;
  color: var(--olas-warn);
  font-size: var(--olas-text-chrome);
  font-variant-numeric: tabular-nums;
}
.olas-devtools-tl-more {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  color: var(--olas-accent);
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: var(--olas-text-chrome);
  text-align: left;
}
.olas-devtools-tl-more:hover { background: var(--olas-row-alt); }

.olas-devtools-tl-group {
  border: 1px solid var(--olas-border-soft);
  border-left: 3px solid var(--olas-muted);
  border-radius: var(--olas-radius-surface);
  margin: 6px 0;
  overflow: hidden;
  background: var(--olas-bg);
}
.olas-devtools-tl-group-error    { border-left-color: var(--olas-error); }
.olas-devtools-tl-group-rollback { border-left-color: var(--olas-warn); }
.olas-devtools-tl-group-ok       { border-left-color: var(--olas-success); }
.olas-devtools-tl-group-active   { border-left-color: var(--olas-accent); }

.olas-devtools-tl-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  background: var(--olas-soft);
  border: 0;
  border-bottom: 1px solid var(--olas-border-soft);
  cursor: pointer;
  font: inherit;
  color: var(--olas-fg);
  text-align: left;
}
.olas-devtools-tl-group-head:hover { background: var(--olas-soft-2); }
.olas-devtools-tl-group-title {
  flex: 1;
  min-width: 0;
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-chrome);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.olas-devtools-tl-group-count {
  min-width: 18px;
  padding: 0 6px;
  height: 16px;
  border-radius: var(--olas-radius-pill);
  background: color-mix(in oklch, var(--olas-fg) 8%, transparent);
  color: var(--olas-muted);
  font-size: var(--olas-text-mark);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
.olas-devtools-tl-group-body {
  padding: 2px 0 2px 6px;
  border-left: 1px dashed var(--olas-border);
  margin-left: 12px;
}

.olas-devtools-tl-row {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--olas-border-soft);
}
.olas-devtools-tl-row:last-child { border-bottom: none; }
.olas-devtools-tl-row-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  min-height: 30px;
}
.olas-devtools-row-clickable > .olas-devtools-tl-row-top { cursor: pointer; user-select: none; }
.olas-devtools-tl-row:hover { background: var(--olas-row-alt); }
.olas-devtools-tl-delta {
  color: var(--olas-muted);
  font-family: var(--olas-font-mono);
  font-size: var(--olas-text-mark);
  font-variant-numeric: tabular-nums;
  background: var(--olas-soft);
  border-radius: var(--olas-radius-mark);
  padding: 1px 5px;
  white-space: nowrap;
}
.olas-devtools-tl-source {
  color: var(--olas-muted);
  font-size: var(--olas-text-chrome);
  margin-bottom: 6px;
}
.olas-devtools-tl-source strong { color: var(--olas-accent); font-weight: 600; }

/* ---- structural diff ------------------------------------------------- */
.olas-devtools-diff-block { display: inline-flex; flex-direction: column; vertical-align: top; }
.olas-devtools-diff-children {
  display: block;
  border-left: 1px dashed var(--olas-border);
  margin-left: 4px;
}
.olas-devtools-diff-row {
  display: block;
  padding-left: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}
.olas-devtools-diff-mark { font-weight: 700; margin-right: 4px; }
.olas-devtools-diff-add,
.olas-devtools-diff-add .olas-devtools-json-string,
.olas-devtools-diff-add .olas-devtools-json-number,
.olas-devtools-diff-add .olas-devtools-json-boolean { color: var(--olas-success); }
.olas-devtools-diff-add { padding: 0 2px; }
.olas-devtools-diff-remove,
.olas-devtools-diff-remove .olas-devtools-json-string,
.olas-devtools-diff-remove .olas-devtools-json-number,
.olas-devtools-diff-remove .olas-devtools-json-boolean { color: var(--olas-error); }
.olas-devtools-diff-remove {
  padding: 0 2px;
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklch, var(--olas-error) 60%, transparent);
}
.olas-devtools-diff-change { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.olas-devtools-diff-prev {
  opacity: 0.7;
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklch, var(--olas-error) 55%, transparent);
}
.olas-devtools-diff-arrow { color: var(--olas-muted); }
.olas-devtools-diff-next {
  padding: 0 2px;
}
.olas-devtools-diff-unchanged {
  display: block;
  padding-left: 14px;
  color: var(--olas-muted);
  font-style: italic;
  font-size: var(--olas-text-mark);
}

/* ---- floating window + launcher -------------------------------------
 * Both sit OUTSIDE .olas-devtools in the DOM, so neither inherits its custom
 * properties. They are named in the token rule at the top of this file for
 * that reason; before that they carried a hardcoded hex fallback beside every
 * var(), which is how the launcher ended up permanently dark in a light app.
 *
 * Both float, so per the edge-or-elevation rule both take the shadow and
 * neither takes a border.
 */
.olas-devtools-launcher {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483645;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 28px;
  background: var(--olas-bg);
  color: var(--olas-fg);
  border: 0;
  border-radius: var(--olas-radius-pill);
  box-shadow: var(--olas-shadow-float);
  cursor: pointer;
  font-family: var(--olas-font-ui);
  font-size: var(--olas-text-meta);
  font-weight: 500;
  transition: background var(--olas-motion-fast) var(--olas-ease-out),
              color var(--olas-motion-fast) var(--olas-ease-out);
}
.olas-devtools-launcher:hover { background: var(--olas-soft-2); }
/* Open is a STATE — the thing you chose — which is the one job the accent has.
   It was a lavender glow, which marked nothing and cost a second carrier. */
.olas-devtools-launcher-active,
.olas-devtools-launcher-active:hover {
  background: var(--olas-accent);
  color: var(--olas-accent-fg);
}
/* The launcher had a green dot with a coloured glow beside a label reading
   "Olas devtools". It was aria-hidden, it never changed, and the label already
   said what it said — a mark carrying no fact. Removed rather than restyled. */

.olas-devtools-floating {
  position: fixed;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  background: var(--olas-bg);
  color: var(--olas-fg);
  border: 0;
  border-radius: var(--olas-radius-surface);
  box-shadow: var(--olas-shadow-float);
  overflow: hidden;
}
.olas-devtools-floating-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px 0 10px;
  background: var(--olas-soft);
  border-bottom: 1px solid var(--olas-border);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.olas-devtools-floating-header:active { cursor: grabbing; }
.olas-devtools-floating-grip {
  color: var(--olas-muted);
  font-size: var(--olas-text-title);
  line-height: 1;
}
.olas-devtools-floating-title {
  flex: 1;
  font-family: var(--olas-font-ui);
  font-size: var(--olas-text-chrome);
  font-weight: 600;
  color: var(--olas-fg);
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
  border-radius: var(--olas-radius-mark);
  color: var(--olas-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--olas-text-title);
  line-height: 1;
  transition: color var(--olas-motion-fast) var(--olas-ease-out),
              background var(--olas-motion-fast) var(--olas-ease-out);
}
.olas-devtools-floating-action:hover {
  color: var(--olas-fg);
  background: var(--olas-soft-2);
}
.olas-devtools-floating-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
/* A surface inside a surface: the panel gives up its own edge and corner to
   the window that now draws them. */
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
  /* Drawn, not decorative: the gradient is how two diagonal rules are painted. */
  background:
    linear-gradient(135deg, transparent 0 7px, var(--olas-muted) 7px 8px, transparent 8px 10px,
                            var(--olas-muted) 10px 11px, transparent 11px 100%);
  opacity: 0.6;
}
.olas-devtools-floating-resize:hover { opacity: 1; }
`
