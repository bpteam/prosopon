export const OVERLAY_ROOT_ID = 'prosopon-root';

/** Where the overlay sits when there is no anchor (voice UI not found): bottom-right, out of the composer's way. */
const FALLBACK = { width: 220, height: 300, margin: 24 };
/** Portrait box around the anchor, relative to the anchor's smaller side. */
const ANCHOR_SCALE = { width: 1.6, height: 2.2 };
const MIN_SIZE = { width: 160, height: 220 };

const HOST_STYLE: Record<string, string> = {
  all: 'initial',
  position: 'fixed',
  'z-index': '2147483647',
  'pointer-events': 'none',
  display: 'block',
  contain: 'strict',
  margin: '0',
  padding: '0',
  border: '0',
  background: 'transparent',
};

const SHADOW_CSS = `
:host { all: initial; }
.stage { position: absolute; inset: 0; }
.stage canvas { display: block; width: 100%; height: 100%; background: transparent; }
.toggles {
  position: absolute; right: 0; top: 0; margin: 0; padding: 3px 5px; pointer-events: auto;
  font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #d8f5d0; background: rgba(0, 0, 0, 0.72);
  border-radius: 4px; display: flex; flex-direction: column;
}
.toggles label { cursor: pointer; white-space: nowrap; }
.debug {
  position: absolute; left: 0; top: 0; margin: 0; padding: 4px 6px; max-width: 100%; overflow: hidden;
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre;
  color: #d8f5d0; background: rgba(0, 0, 0, 0.72); border-radius: 4px;
}
`;

export type OverlayPlacement = 'anchor' | 'fallback';

/**
 * The extension's own root on the page: a fixed, click-through host with a shadow root, so page CSS can't reach
 * the canvas/debug UI and ours can't reach the page. Knows an anchor element to sit over, never how to find it.
 */
export class AvatarOverlay {
  readonly host: HTMLDivElement;
  /** Container for the renderer's canvas. */
  readonly stageContainer: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly debugEl: HTMLPreElement | null;
  private togglesEl: HTMLDivElement | null = null;
  private anchor: HTMLElement | null = null;
  private readonly resizeObserver: ResizeObserver;
  private placementValue: OverlayPlacement = 'fallback';
  private frame: number | null = null;

  constructor(private readonly doc: Document = document, options: { debug?: boolean } = {}) {
    const host = doc.createElement('div');
    host.id = OVERLAY_ROOT_ID;
    for (const [k, v] of Object.entries(HOST_STYLE)) host.style.setProperty(k, v, 'important');
    this.host = host;
    // Open so tests and DevTools can inspect it; isolation of styles is the same as with a closed root.
    this.shadow = host.attachShadow({ mode: 'open' });

    const style = doc.createElement('style');
    style.textContent = SHADOW_CSS;
    this.stageContainer = doc.createElement('div');
    this.stageContainer.className = 'stage';
    this.shadow.append(style, this.stageContainer);

    this.debugEl = options.debug ? doc.createElement('pre') : null;
    if (this.debugEl) {
      this.debugEl.className = 'debug';
      this.shadow.append(this.debugEl);
    }

    this.resizeObserver = new ResizeObserver(() => this.schedulePlace());
    const view = doc.defaultView;
    view?.addEventListener('resize', this.schedulePlace);
    // Capture: the anchor can be inside any scrolling container.
    view?.addEventListener('scroll', this.schedulePlace, { capture: true, passive: true });

    // documentElement, not body: a framework re-rendering body's children can't take the host with it.
    doc.documentElement.append(host);
    this.place();
  }

  get placement(): OverlayPlacement {
    return this.placementValue;
  }

  /** Sit over `element` (ChatGPT's orb or voice container), or at the fallback position with null. */
  setAnchor(element: HTMLElement | null): void {
    if (element === this.anchor) return;
    if (this.anchor) this.resizeObserver.unobserve(this.anchor);
    this.anchor = element;
    if (element) this.resizeObserver.observe(element);
    this.place();
  }

  /**
   * Debug builds: a checkbox that stays clickable (the rest of the overlay lets clicks through to the page).
   * @returns the input, for syncing its state
   */
  addDebugToggle(id: string, label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement | null {
    if (!this.debugEl) return null;
    if (!this.togglesEl) {
      this.togglesEl = this.doc.createElement('div');
      this.togglesEl.className = 'toggles';
      this.shadow.append(this.togglesEl);
    }
    const row = this.doc.createElement('label');
    const input = this.doc.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(input, this.doc.createTextNode(` ${label}`));
    this.togglesEl.append(row);
    return input;
  }

  setDebugText(text: string): void {
    if (this.debugEl && this.debugEl.textContent !== text) this.debugEl.textContent = text;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    const view = this.doc.defaultView;
    view?.removeEventListener('resize', this.schedulePlace);
    view?.removeEventListener('scroll', this.schedulePlace, { capture: true });
    if (this.frame !== null) view?.cancelAnimationFrame(this.frame);
    this.host.remove();
  }

  private readonly schedulePlace = (): void => {
    const view = this.doc.defaultView;
    if (!view || this.frame !== null) return;
    this.frame = view.requestAnimationFrame(() => {
      this.frame = null;
      this.place();
    });
  };

  private place(): void {
    const view = this.doc.defaultView;
    const vw = view?.innerWidth ?? 0;
    const vh = view?.innerHeight ?? 0;
    const rect = this.anchor?.isConnected ? this.anchor.getBoundingClientRect() : null;
    let box: { left: number; top: number; width: number; height: number };
    if (rect && rect.width > 0 && rect.height > 0) {
      const side = Math.min(rect.width, rect.height);
      const width = clamp(side * ANCHOR_SCALE.width, MIN_SIZE.width, vw);
      const height = clamp(side * ANCHOR_SCALE.height, MIN_SIZE.height, vh);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Centred on the anchor, then pushed inside the viewport so the avatar is never clipped.
      box = {
        left: clamp(cx - width / 2, 0, Math.max(0, vw - width)),
        top: clamp(cy - height / 2, 0, Math.max(0, vh - height)),
        width,
        height,
      };
      this.placementValue = 'anchor';
    } else {
      box = {
        left: Math.max(0, vw - FALLBACK.width - FALLBACK.margin),
        top: Math.max(0, vh - FALLBACK.height - FALLBACK.margin),
        width: FALLBACK.width,
        height: FALLBACK.height,
      };
      this.placementValue = 'fallback';
    }
    const s = this.host.style;
    s.setProperty('left', `${Math.round(box.left)}px`, 'important');
    s.setProperty('top', `${Math.round(box.top)}px`, 'important');
    s.setProperty('width', `${Math.round(box.width)}px`, 'important');
    s.setProperty('height', `${Math.round(box.height)}px`, 'important');
    this.host.dataset.placement = this.placementValue;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
