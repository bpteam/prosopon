// Tiny DOM helpers for the plain-TypeScript UI (no framework).

type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;
type Child = Node | string | null | undefined | false;

/** Element with attributes (`on*` functions become listeners, booleans toggle attributes) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return el;
}

/** Parses an inline SVG icon string into an element. */
export function svg(doc: Document, markup: string, className = 'icon'): SVGElement {
  const t = doc.createElement('template');
  t.innerHTML = markup.trim();
  const el = t.content.firstElementChild as SVGElement;
  el.setAttribute('class', className);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Sets text only when it changed (DOM writes are the cost of a 10 Hz panel). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Toggle switch: <label class="switch"><input type=checkbox role=switch><span class=track></label>. */
export function toggleSwitch(doc: Document, label: string, checked: boolean, onChange: (checked: boolean) => void, id?: string) {
  const input = h(doc, 'input', { type: 'checkbox', role: 'switch', 'aria-label': label, id });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const el = h(doc, 'label', { class: 'switch' }, input, h(doc, 'span', { class: 'track' }));
  return { el, input };
}

export function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}
