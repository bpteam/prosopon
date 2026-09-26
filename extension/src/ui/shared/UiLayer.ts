import { UI_ROOT_ID } from '../../content/AvatarOverlay';
import { CONTROLS_CSS, TOKENS_CSS } from './tokens';

export { UI_ROOT_ID };

const HOST_STYLE: Record<string, string> = {
  all: 'initial',
  position: 'fixed',
  inset: '0',
  width: '100vw',
  height: '100vh',
  // Same layer as the avatar overlay, appended after it: panels draw above the avatar.
  'z-index': '2147483647',
  'pointer-events': 'none',
  display: 'block',
  margin: '0',
  padding: '0',
  border: '0',
  background: 'transparent',
  overflow: 'visible',
};

const LAYER_CSS = `
:host { all: initial; ${TOKENS_CSS} }
${CONTROLS_CSS}
.layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
/* Only Prosopon's own panels take pointer events; everything between them stays ChatGPT's. */
.layer > * { pointer-events: auto; }
`;

/**
 * Isolated root for Prosopon's interactive in-page UI (placement handle, quick toolbar, developer windows): a fixed,
 * click-through host with its own shadow root, next to the avatar overlay. ChatGPT's CSS can't reach it, its CSS
 * can't reach ChatGPT, and only the panels themselves receive pointer events.
 */
export class UiLayer {
  readonly host: HTMLDivElement;
  readonly shadow: ShadowRoot;
  /** Container for panels. */
  readonly root: HTMLDivElement;
  private readonly styles = new Set<string>();

  constructor(readonly doc: Document = document) {
    const host = doc.createElement('div');
    host.id = UI_ROOT_ID;
    for (const [k, v] of Object.entries(HOST_STYLE)) host.style.setProperty(k, v, 'important');
    this.host = host;
    this.shadow = host.attachShadow({ mode: 'open' });
    this.addStyle('layer', LAYER_CSS);
    this.root = doc.createElement('div');
    this.root.className = 'layer ui';
    this.shadow.append(this.root);
    doc.documentElement.append(host);
  }

  get viewport(): { width: number; height: number } {
    const view = this.doc.defaultView;
    return { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 };
  }

  /** Adds a stylesheet once per id (panels bring their own CSS). */
  addStyle(id: string, css: string): void {
    if (this.styles.has(id)) return;
    this.styles.add(id);
    const style = this.doc.createElement('style');
    style.dataset.id = id;
    style.textContent = css;
    this.shadow.append(style);
  }

  dispose(): void {
    this.host.remove();
  }
}
