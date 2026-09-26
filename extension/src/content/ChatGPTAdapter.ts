/**
 * What the avatar integration needs to know about a conversation UI. Implemented once per site; nothing outside
 * the implementation knows the site's DOM.
 */
export interface ConversationUiAdapter {
  isVoiceModeActive(): boolean;
  findVoiceContainer(): HTMLElement | null;
  /** The site's own voice visual (ChatGPT's orb), if it can be found. */
  findOrb(): HTMLElement | null;
  /**
   * Calls `listener` with the current snapshot, then whenever it changes. Driven by a MutationObserver, not by
   * polling. @returns stop observing
   */
  observe(listener: (ui: VoiceUiSnapshot) => void): () => void;
  /** Hides `element` visually without removing it from the DOM. @returns restore (idempotent) */
  hideVisually(element: HTMLElement): () => void;
}

export interface VoiceUiSnapshot {
  active: boolean;
  container: HTMLElement | null;
  orb: HTMLElement | null;
}

/**
 * ChatGPT's DOM, in one place. These selectors are NOT verified against the live chatgpt.com voice mode (it isn't
 * reachable from CI): they are best guesses to be updated from DevTools, and E2E fixtures mirror them. When none
 * matches, voice mode reads as inactive: the orb stays visible and the avatar stays in its fallback position.
 * Order matters: the first match wins.
 */
export const CHATGPT_SELECTORS = {
  voiceContainer: [
    '[data-testid="voice-mode-container"]',
    '[data-testid="voice-mode"]',
    '[data-testid*="voice-mode" i]',
    '[aria-label*="voice mode" i][role="dialog"]',
  ],
  /** Looked up inside the voice container. */
  orb: ['[data-testid="voice-orb"]', '[data-testid*="orb" i]', 'canvas'],
} as const;

/** Attributes whose changes can show or hide the voice UI. `class` is left out: ChatGPT rewrites it constantly. */
const OBSERVED_ATTRIBUTES = ['data-testid', 'hidden', 'aria-hidden', 'aria-label', 'role'];

const HIDDEN_MARK = 'data-prosopon-hidden';

export class ChatGPTAdapter implements ConversationUiAdapter {
  constructor(private readonly doc: Document = document) {}

  isVoiceModeActive(): boolean {
    return this.findVoiceContainer() !== null;
  }

  findVoiceContainer(): HTMLElement | null {
    for (const selector of CHATGPT_SELECTORS.voiceContainer) {
      const el = this.doc.querySelector<HTMLElement>(selector);
      if (el && isShown(el)) return el;
    }
    return null;
  }

  findOrb(container: HTMLElement | null = this.findVoiceContainer()): HTMLElement | null {
    if (!container) return null;
    for (const selector of CHATGPT_SELECTORS.orb) {
      const el = container.querySelector<HTMLElement>(selector);
      if (el) return el;
    }
    return null;
  }

  snapshot(): VoiceUiSnapshot {
    const container = this.findVoiceContainer();
    return { active: container !== null, container, orb: this.findOrb(container) };
  }

  observe(listener: (ui: VoiceUiSnapshot) => void): () => void {
    let last = this.snapshot();
    listener(last);
    const check = () => {
      const next = this.snapshot();
      if (next.active === last.active && next.container === last.container && next.orb === last.orb) return;
      last = next;
      listener(next);
    };
    // MutationObserver already batches all mutations of a task into one callback.
    const observer = new MutationObserver(check);
    observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
    return () => observer.disconnect();
  }

  hideVisually(element: HTMLElement): () => void {
    if (element.hasAttribute(HIDDEN_MARK)) return () => {};
    // Inline style, not removal: the node is React-managed and must stay where React expects it.
    const style = element.style;
    const previous = { value: style.getPropertyValue('visibility'), priority: style.getPropertyPriority('visibility') };
    style.setProperty('visibility', 'hidden', 'important');
    element.setAttribute(HIDDEN_MARK, '');
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      element.removeAttribute(HIDDEN_MARK);
      if (previous.value) style.setProperty('visibility', previous.value, previous.priority);
      else style.removeProperty('visibility');
    };
  }
}

function isShown(el: HTMLElement): boolean {
  return !el.hidden && el.getAttribute('aria-hidden') !== 'true';
}
