import { clampWindowBounds, type DevWindowSpec, type Viewport, type WindowBounds } from '../../shared/settings';
import { h, svg } from './dom';
import { ICONS } from './icons';

export const FLOATING_WINDOW_CSS = `
.win {
  position: absolute; display: flex; flex-direction: column; background: rgba(16,21,28,.96);
  border: 1px solid var(--border-strong); border-radius: var(--radius-panel); color: var(--text);
  box-shadow: 0 18px 50px rgba(0,0,0,.45); overflow: hidden; backdrop-filter: blur(10px);
}
.win-head {
  display: flex; align-items: center; gap: var(--gap-s); height: 40px; min-height: 40px; padding: 0 6px 0 14px;
  border-bottom: 1px solid var(--border); cursor: grab; user-select: none; touch-action: none;
}
.win-head.dragging { cursor: grabbing; }
.win-title { font: 600 13px/1 var(--font); flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.win-body { flex: 1 1 auto; overflow: auto; padding: 12px 14px 14px; }
.win-grip { position: absolute; z-index: 2; touch-action: none; }
.win-grip.r { top: 40px; right: -3px; bottom: 10px; width: 8px; cursor: ew-resize; }
.win-grip.b { left: 10px; right: 10px; bottom: -3px; height: 8px; cursor: ns-resize; }
.win-grip.br { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
.win-grip.br::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px;
  border-right: 2px solid var(--text-muted); border-bottom: 2px solid var(--text-muted); border-radius: 0 0 2px 0; }
`;

export interface WindowAction {
  id: string;
  label: string;
  icon: string;
  onClick(button: HTMLButtonElement): void;
  pressed?: boolean;
}

export interface FloatingWindowOptions {
  title: string;
  spec: Pick<DevWindowSpec, 'minWidth' | 'minHeight' | 'margin' | 'resizable'>;
  /** Starting geometry (restored or initial); clamped to the viewport before it is shown. */
  bounds: WindowBounds;
  viewport: () => Viewport;
  /** Header buttons before the close button. */
  actions?: WindowAction[];
  /** Geometry changed: `final` on pointerup (flush), otherwise during a drag (debounce). */
  onBounds(bounds: WindowBounds, final: boolean): void;
  /** Close button or Escape (while focus is inside the window). */
  onClose(reason: 'button' | 'escape'): void;
  /** Height follows content (Debug HUD): only max-height is set. */
  autoHeight?: boolean;
  testId?: string;
}

let topZ = 1;

/**
 * Draggable (by the header), optionally resizable (right, bottom, bottom-right), clamped to the viewport so at least
 * the header stays reachable. Plain DOM inside the caller's shadow root; Escape closes it while focus is inside.
 */
export class FloatingWindow {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private boundsValue: WindowBounds;
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor(doc: Document, private readonly options: FloatingWindowOptions) {
    this.boundsValue = clampWindowBounds(options.bounds, options.viewport(), options.spec, 'restore');
    const title = h(doc, 'div', { class: 'win-title', id: `${options.testId ?? 'win'}-title` }, options.title);
    const actions = (options.actions ?? []).map((a) => {
      const b = h(doc, 'button', { class: 'icon-btn', type: 'button', 'aria-label': a.label, title: a.label, 'data-action': a.id });
      if (a.pressed !== undefined) b.setAttribute('aria-pressed', String(a.pressed));
      b.append(svg(doc, a.icon, 'icon s'));
      b.addEventListener('click', () => a.onClick(b));
      this.buttons.set(a.id, b);
      return b;
    });
    const close = h(doc, 'button', { class: 'icon-btn', type: 'button', 'aria-label': `Close ${options.title}`, title: 'Close', 'data-action': 'close' });
    close.append(svg(doc, ICONS.close, 'icon s'));
    close.addEventListener('click', () => options.onClose('button'));
    this.buttons.set('close', close);
    this.head = h(doc, 'div', { class: 'win-head' }, title, ...actions, close);
    this.body = h(doc, 'div', { class: 'win-body' });
    this.el = h(doc, 'div', {
      class: 'win',
      role: 'dialog',
      'aria-labelledby': title.id,
      tabindex: -1,
      'data-testid': options.testId,
    });
    this.el.append(this.head, this.body);
    if (options.spec.resizable) {
      for (const edge of ['r', 'b', 'br'] as const) {
        const grip = h(doc, 'div', { class: `win-grip ${edge}`, 'aria-hidden': 'true' });
        grip.addEventListener('pointerdown', (e) => this.startGesture(e as PointerEvent, edge));
        this.el.append(grip);
      }
    }
    this.head.addEventListener('pointerdown', (e) => {
      // Buttons in the header keep their clicks.
      if ((e.target as Element | null)?.tagName === 'BUTTON' || (e.target as Element | null)?.parentElement?.tagName === 'BUTTON') return;
      this.startGesture(e as PointerEvent, 'move');
    });
    this.el.addEventListener('pointerdown', () => this.raise(), { capture: true });
    this.el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') {
        e.stopPropagation();
        options.onClose('escape');
      }
    });
    this.raise();
    this.apply();
  }

  get bounds(): Readonly<WindowBounds> {
    return this.boundsValue;
  }

  button(id: string): HTMLButtonElement | undefined {
    return this.buttons.get(id);
  }

  /** Re-fits after a viewport change (restore rules: brought fully inside when it fits). */
  refit(): void {
    const next = clampWindowBounds(this.boundsValue, this.options.viewport(), this.options.spec, 'restore');
    if (sameBounds(next, this.boundsValue)) return;
    this.boundsValue = next;
    this.apply();
    this.options.onBounds(next, true);
  }

  /** Programmatic move (tests, keyboard). Clamped with the drag rules. */
  moveTo(x: number, y: number, final = true): void {
    this.setBounds({ ...this.boundsValue, x, y }, final);
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  dispose(): void {
    this.el.remove();
  }

  private raise(): void {
    this.el.style.zIndex = String(++topZ);
  }

  private setBounds(b: WindowBounds, final: boolean): void {
    const next = clampWindowBounds(b, this.options.viewport(), this.options.spec, 'drag');
    const changed = !sameBounds(next, this.boundsValue);
    this.boundsValue = next;
    if (changed) this.apply();
    if (changed || final) this.options.onBounds(next, final);
  }

  private apply(): void {
    const b = this.boundsValue;
    const s = this.el.style;
    s.left = `${b.x}px`;
    s.top = `${b.y}px`;
    s.width = `${b.width}px`;
    if (this.options.autoHeight) s.maxHeight = `${b.height}px`;
    else s.height = `${b.height}px`;
  }

  private startGesture(e: PointerEvent, kind: 'move' | 'r' | 'b' | 'br'): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const start = { ...this.boundsValue, px: e.clientX, py: e.clientY };
    if (kind === 'move') this.head.classList.add('dragging');
    const onMove = (ev: Event) => {
      const m = ev as PointerEvent;
      const dx = m.clientX - start.px;
      const dy = m.clientY - start.py;
      if (kind === 'move') this.setBounds({ ...start, x: start.x + dx, y: start.y + dy }, false);
      else
        this.setBounds(
          {
            ...start,
            width: kind === 'b' ? start.width : start.width + dx,
            height: kind === 'r' ? start.height : start.height + dy,
          },
          false,
        );
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      this.head.classList.remove('dragging');
      this.options.onBounds(this.boundsValue, true);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
}

function sameBounds(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
