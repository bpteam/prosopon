import { fmt, h, setText, toggleSwitch } from '../shared/dom';
import type { RingBuffer } from '../shared/RingBuffer';
import { Sparkline, type SparklineOptions } from '../shared/Sparkline';

// Small building blocks of the developer panels. Each returns its element and an update function; nothing here
// polls or ticks by itself.

export interface Chart {
  el: HTMLElement;
  update(text: string): void;
  draw(): void;
}

/** Label, current value, sparkline of the last 30 s. */
export function metricChart(doc: Document, label: string, buffer: RingBuffer, options: SparklineOptions = {}): Chart {
  const value = h(doc, 'span', { class: 'value' }, '—');
  const spark = new Sparkline(doc, buffer, { height: 28, ...options });
  const el = h(doc, 'div', { class: 'metric' }, h(doc, 'div', { class: 'metric-head' }, h(doc, 'span', { class: 'tiny' }, label), value), spark.canvas);
  return { el, update: (text) => setText(value, text), draw: () => spark.draw() };
}

export interface BarRow {
  el: HTMLElement;
  set(value: number, text?: string): void;
}

/** Horizontal bar 0..max with a numeric label. */
export function barRow(doc: Document, label: string, color = 'var(--blue)', max = 1): BarRow {
  const fill = h(doc, 'i');
  fill.style.background = color;
  const num = h(doc, 'span', { class: 'tiny num' }, '0.00');
  const el = h(doc, 'div', { class: 'bar-row' }, h(doc, 'span', { class: 'tiny label' }, label), h(doc, 'div', { class: 'bar' }, fill), num);
  let last = -1;
  return {
    el,
    set(value, text) {
      const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value / max)) : 0;
      const pct = Math.round(v * 1000) / 10;
      if (pct !== last) {
        fill.style.width = `${pct}%`;
        last = pct;
      }
      setText(num, text ?? fmt(value));
    },
  };
}

export interface KeyValue {
  el: HTMLElement;
  set(text: string): void;
}

export function keyValue(doc: Document, label: string): KeyValue {
  const v = h(doc, 'span', { class: 'value' }, '—');
  return { el: h(doc, 'div', { class: 'kv' }, h(doc, 'span', { class: 'secondary' }, label), v), set: (t) => setText(v, t) };
}

export function card(doc: Document, title: string, ...children: HTMLElement[]): HTMLElement {
  return h(doc, 'section', { class: 'card dev-card' }, h(doc, 'h3', { class: 'section-title' }, title), ...children);
}

export interface Tabs {
  el: HTMLElement;
  panels: Map<string, HTMLElement>;
  readonly selected: string;
  select(name: string): void;
}

/** role=tablist; arrow keys move between tabs; only the selected panel is laid out (and updated by its owner). */
export function tabs(doc: Document, names: readonly string[], selected: string, onSelect: (name: string) => void, idPrefix: string): Tabs {
  const list = h(doc, 'div', { class: 'tabs', role: 'tablist' });
  const panels = new Map<string, HTMLElement>();
  const buttons = new Map<string, HTMLButtonElement>();
  let current = names.includes(selected) ? selected : names[0]!;
  const body = h(doc, 'div', { class: 'tab-panels' });
  for (const name of names) {
    const id = `${idPrefix}-${name.toLowerCase().replace(/\s+/g, '-')}`;
    const b = h(doc, 'button', { type: 'button', role: 'tab', class: 'tab', id: `${id}-tab`, 'aria-controls': `${id}-panel`, 'data-tab': name }, name);
    b.addEventListener('click', () => api.select(name));
    b.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft') return;
      const i = names.indexOf(name) + (k === 'ArrowRight' ? 1 : -1);
      const next = names[(i + names.length) % names.length]!;
      api.select(next);
      buttons.get(next)!.focus();
    });
    buttons.set(name, b);
    list.append(b);
    const panel = h(doc, 'div', { class: 'tab-panel', role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': `${id}-tab` });
    panels.set(name, panel);
    body.append(panel);
  }
  const api: Tabs = {
    el: h(doc, 'div', { class: 'tabs-wrap' }, list, body),
    panels,
    get selected() {
      return current;
    },
    select(name) {
      current = name;
      for (const [n, b] of buttons) {
        b.setAttribute('aria-selected', String(n === name));
        b.tabIndex = n === name ? 0 : -1;
        panels.get(n)!.classList.toggle('hidden', n !== name);
      }
      onSelect(name);
    },
  };
  api.select(current);
  return api;
}

/** A labelled switch row. */
export function switchRow(doc: Document, label: string, checked: boolean, onChange: (on: boolean) => void, id?: string) {
  const s = toggleSwitch(doc, label, checked, onChange, id);
  return { el: h(doc, 'label', { class: 'row switch-row' }, h(doc, 'span', { class: 'grow' }, label), s.el), input: s.input };
}

export interface SliderRow {
  el: HTMLElement;
  input: HTMLInputElement;
  set(value: number): void;
}

/** Range input with label and formatted value; `onInput` while dragging, `onCommit` on change (flush). */
export function sliderRow(
  doc: Document,
  label: string,
  range: { min: number; max: number; step: number },
  value: number,
  format: (v: number) => string,
  onInput: (v: number) => void,
  onCommit: (v: number) => void = onInput,
  testId?: string,
): SliderRow {
  const input = h(doc, 'input', { type: 'range', min: range.min, max: range.max, step: range.step, 'aria-label': label, 'data-testid': testId });
  input.value = String(value);
  const out = h(doc, 'span', { class: 'tiny num' }, format(value));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    setText(out, format(v));
    onInput(v);
  });
  input.addEventListener('change', () => onCommit(Number(input.value)));
  const el = h(doc, 'div', { class: 'slider-row' }, h(doc, 'span', { class: 'secondary' }, label), input, out);
  return {
    el,
    input,
    set(v) {
      // Don't fight the user's drag: a focused slider keeps its own value.
      if ((input.getRootNode() as Document | ShadowRoot).activeElement === input) return;
      if (input.value !== String(v)) input.value = String(v);
      setText(out, format(v));
    },
  };
}

export const STATE_COLORS: Record<string, string> = {
  idle: 'var(--text-muted)',
  listening: 'var(--green)',
  thinking: 'var(--accent)',
  speaking: 'var(--purple)',
};

export const DEV_CSS = `
.dev-card { display: flex; flex-direction: column; gap: var(--gap-s); min-width: 0; }
.dev-card > h3 { margin-bottom: 2px; }
.section { display: flex; flex-direction: column; gap: var(--gap-s); padding: var(--gap) 0; border-top: 1px solid var(--border); }
.section:first-child { border-top: 0; padding-top: 0; }
.section-label { font: 600 12px/1 var(--font); color: var(--text-secondary); text-transform: none; }
.metric { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.metric-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.metric .value { font-size: 13px; }
canvas.spark { display: block; width: 100%; background: rgba(255,255,255,.025); border-radius: 5px; }
.grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--gap); }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap); }
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap); }
.overview { display: grid; grid-template-columns: 1.3fr 1fr 1fr; grid-template-rows: auto auto; gap: var(--gap); }
.bar-row { display: grid; grid-template-columns: 116px 1fr 40px; align-items: center; gap: 8px; }
.bar-row.short { grid-template-columns: 28px 1fr 40px; }
.bar-row .num, .slider-row .num { text-align: right; }
.kv { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
.kv .value { font-size: 13px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.state-line { display: flex; align-items: center; gap: 8px; font: 600 13px/1 var(--font); }
.state-line .state { text-transform: uppercase; letter-spacing: .04em; }
.perf-line { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.tabs-wrap { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: -12px -14px 12px; padding: 0 10px; overflow-x: auto; }
.tab { background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--text-secondary); font-weight: 500; padding: 10px 10px 9px; min-height: 0; }
.tab:hover { background: transparent; color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.tab-panel { display: flex; flex-direction: column; gap: var(--gap); }
.switch-row { cursor: pointer; padding: 4px 0; }
.slider-row { display: grid; grid-template-columns: 110px 1fr 58px; align-items: center; gap: 10px; }
.btn-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap-s); }
.presets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap-s); }
.preset { flex-direction: column; gap: 6px; padding: 10px 6px 8px; min-height: 84px; font-weight: 600; }
.preset svg { width: 48px; height: 40px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.preset[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.actions { display: flex; flex-wrap: wrap; gap: var(--gap-s); }
.toolbar {
  position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); height: 48px; display: flex; align-items: center;
  gap: 4px; padding: 0 8px; background: rgba(16,21,28,.82); border: 1px solid var(--border-strong); border-radius: 14px;
  backdrop-filter: blur(12px); box-shadow: 0 10px 30px rgba(0,0,0,.35);
  /* Above every floating window (they stack from 1 up): the camera controls are never covered. */
  z-index: 1000000;
}
.toolbar button { min-height: 32px; height: 32px; padding: 0 10px; background: transparent; border-color: transparent; font-weight: 500; }
.toolbar button:hover { background: var(--bg-hover); }
.toolbar button[aria-pressed="true"] { background: var(--accent); color: #fff; }
.toolbar button.icon-only { width: 32px; padding: 0; }
.toolbar .sep { width: 1px; height: 22px; background: var(--border-strong); margin: 0 4px; }
.toolbar .scale { min-width: 46px; text-align: center; font: 600 13px/1 var(--font); font-variant-numeric: tabular-nums; }
.note { font-size: 12px; color: var(--text-secondary); margin: 0; }
.sem-list { display: flex; flex-direction: column; gap: var(--gap-s); max-height: 360px; overflow-y: auto; }
.sem-entry { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,.03); border-left: 2px solid var(--border-strong); }
.sem-entry.accepted { border-left-color: var(--yellow); }
.sem-text { font-size: 12px; color: var(--text); }
.sem-entry .mono { font-family: ui-monospace, monospace; white-space: pre-wrap; color: var(--text-secondary); }
.sem-verdict { color: var(--text-secondary); }
.sem-entry.accepted .sem-verdict { color: var(--yellow); }
`;
