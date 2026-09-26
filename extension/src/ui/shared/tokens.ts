// One design language for the popup and the in-page developer UI. Tokens are CSS variables on the root the UI lives
// in (:host of a shadow root, or :root of the popup). Dark regardless of ChatGPT's theme.

export const FONT_STACK = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const TOKENS_CSS = `
  --bg-page: #080b0f;
  --bg-panel: #10151c;
  --bg-card: #151c25;
  --bg-hover: #1b2430;
  --border: rgba(255,255,255,.10);
  --border-strong: rgba(255,255,255,.16);
  --text: #f3f5f7;
  --text-secondary: #9aa5b1;
  --text-muted: #6f7b87;
  --accent: #ff6422;
  --accent-hover: #ff7438;
  --blue: #2684ff;
  --green: #29c978;
  --yellow: #f6c84c;
  --red: #e14b43;
  --purple: #a968ff;

  --radius-panel: 12px;
  --radius-card: 10px;
  --radius-button: 8px;
  --radius-control: 7px;
  --gap-s: 6px;
  --gap: 10px;
  --gap-section: 16px;
  --pad-panel: 16px;
  --pad-card: 12px;
  --font: ${FONT_STACK};
`;

/** Controls shared by the popup and the in-page windows. Scoped by the caller's root (shadow root or page). */
export const CONTROLS_CSS = `
  * { box-sizing: border-box; }
  .ui { font: 400 13px/1.4 var(--font); color: var(--text); -webkit-font-smoothing: antialiased; }
  .secondary { font-size: 12px; color: var(--text-secondary); }
  .muted { color: var(--text-muted); }
  .tiny { font: 500 11px/1.3 var(--font); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .section-title { font: 600 14px/1.3 var(--font); margin: 0; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-card); padding: var(--pad-card); }
  .row { display: flex; align-items: center; gap: var(--gap); }
  .grow { flex: 1 1 auto; min-width: 0; }
  .hidden { display: none !important; }
  .icon { width: 18px; height: 18px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .icon.s { width: 16px; height: 16px; }

  button, .btn {
    font: 600 13px/1 var(--font); color: var(--text); background: var(--bg-hover); border: 1px solid var(--border);
    border-radius: var(--radius-button); padding: 8px 12px; cursor: pointer; display: inline-flex; align-items: center;
    justify-content: center; gap: var(--gap-s); min-height: 32px;
  }
  button:hover { border-color: var(--border-strong); background: #212c3a; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.danger { background: transparent; color: var(--red); border-color: rgba(225,75,67,.35); }
  button.danger:hover { background: rgba(225,75,67,.12); }
  button.ghost { background: transparent; border-color: transparent; }
  button.ghost:hover { background: var(--bg-hover); }
  button.icon-btn { padding: 0; width: 28px; min-height: 28px; height: 28px; background: transparent; border-color: transparent; color: var(--text-secondary); }
  button.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
  button.icon-btn[aria-pressed="true"] { color: var(--accent); }
  button.selected, button[aria-pressed="true"].seg { background: var(--accent); border-color: var(--accent); color: #fff; }
  :focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }

  .switch { position: relative; width: 36px; height: 20px; flex: none; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .switch .track { position: absolute; inset: 0; border-radius: 10px; background: #2a3441; transition: background .15s; pointer-events: none; }
  .switch .track::after { content: ''; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%; background: #d6dce2; transition: transform .15s; }
  .switch input:checked + .track { background: var(--accent); }
  .switch input:checked + .track::after { transform: translateX(16px); background: #fff; }
  .switch input:focus-visible + .track { outline: 2px solid var(--blue); outline-offset: 1px; }
  .switch input:disabled + .track { opacity: .45; }

  input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 20px; background: transparent; margin: 0; cursor: pointer; }
  input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: #2a3441; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--text); margin-top: -5px; border: 0; }
  input[type=range]:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--blue); outline-offset: 2px; }

  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex: none; }
  .dot.green { background: var(--green); } .dot.orange { background: var(--accent); } .dot.red { background: var(--red); }
  .dot.blue { background: var(--blue); } .dot.purple { background: var(--purple); } .dot.yellow { background: var(--yellow); }

  .bar { position: relative; height: 6px; border-radius: 3px; background: #222b36; overflow: hidden; }
  .bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--blue); width: 0; }
  .badge { font: 500 11px/1 var(--font); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; }
`;
