export const OVERLAY_ROOT_ID = 'prosopon-root';
/** Host of the interactive in-page UI (UiLayer), next to the render overlay. */
export const UI_ROOT_ID = 'prosopon-ui';

const HOST_STYLE: Record<string, string> = {
  all: 'initial',
  position: 'fixed',
  inset: '0',
  width: '100vw',
  height: '100vh',
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
`;

/**
 * The avatar's render surface on the page: a fixed, click-through host covering the whole viewport, with a shadow
 * root so page CSS can't reach the canvas and ours can't reach the page. Where the avatar appears and how large is
 * decided by the camera and the saved placement (AvatarStage presentation), never by cropping this canvas.
 * Interactive UI (placement handle, developer windows) lives in a separate root (UiLayer): this one never takes a
 * pointer event.
 */
export class AvatarOverlay {
  readonly host: HTMLDivElement;
  /** Container for the renderer's canvas. */
  readonly stageContainer: HTMLDivElement;
  private readonly shadow: ShadowRoot;

  constructor(doc: Document = document) {
    const host = doc.createElement('div');
    host.id = OVERLAY_ROOT_ID;
    for (const [k, v] of Object.entries(HOST_STYLE)) host.style.setProperty(k, v, 'important');
    host.dataset.placement = 'viewport';
    this.host = host;
    // Open so tests and DevTools can inspect it; isolation of styles is the same as with a closed root.
    this.shadow = host.attachShadow({ mode: 'open' });

    const style = doc.createElement('style');
    style.textContent = SHADOW_CSS;
    this.stageContainer = doc.createElement('div');
    this.stageContainer.className = 'stage';
    this.shadow.append(style, this.stageContainer);

    // documentElement, not body: a framework re-rendering body's children can't take the host with it.
    doc.documentElement.append(host);
  }

  dispose(): void {
    this.host.remove();
  }
}
