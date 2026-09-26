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
 * ChatGPT's DOM, in one place. Verified against production chatgpt.com voice mode (2026-09-26): the live voice
 * session renders one orb element carrying `data-realtime-voice-orb`, both in the composer (112px) and in voice
 * focus mode (256px); the orb is absent from the DOM when no voice session is running. Order matters: the first
 * match wins. Older entries are kept as fallbacks for other ChatGPT builds.
 */
export const CHATGPT_SELECTORS = {
  /**
   * The site's voice visual. Its presence is what "voice mode is active" means: React unmounts it when the
   * session ends. `data-realtime-voice-orb` and `data-testid` are stable attributes, not generated classes.
   */
  orb: [
    '[data-realtime-voice-orb]',
    '[data-testid="avatar-overlay-voice-orb"]',
    '[data-avatar-mascot="true"]',
    '[data-testid="voice-orb"]',
    '[data-testid*="orb" i]',
  ],
  /**
   * The layout box the avatar anchors to, looked up from the orb upwards. Production has no voice dialog: in
   * focus mode the nearest stable ancestor is `[data-thread-focus-mode]`; in the composer there is none, and the
   * orb's own button is used.
   */
  container: [
    '[data-thread-focus-mode]',
    '[data-testid="voice-mode-container"]',
    '[data-testid="voice-mode"]',
    '[aria-label*="voice mode" i][role="dialog"]',
  ],
  /** Fallback evidence of a live session while the orb is momentarily unmounted (e.g. mid transition). */
  sessionControl: ['button[aria-label="End Voice" i]', 'button[aria-label*="voice focus mode" i]'],
} as const;

/** Attributes whose changes can show or hide the voice UI. `class` is left out: ChatGPT rewrites it constantly. */
const OBSERVED_ATTRIBUTES = ['data-testid', 'data-realtime-voice-orb', 'data-thread-focus-mode', 'hidden', 'aria-hidden', 'aria-label', 'role'];

const HIDDEN_MARK = 'data-prosopon-hidden';

export class ChatGPTAdapter implements ConversationUiAdapter {
  constructor(private readonly doc: Document = document) {}

  isVoiceModeActive(): boolean {
    return this.findOrb() !== null || this.findSessionControl() !== null;
  }

  /**
   * The box to anchor to: the orb's nearest known container, else the button wrapping the orb, else the orb.
   * Without an orb, only a document-wide container counts (and only while a session control says a session runs).
   */
  findVoiceContainer(orb: HTMLElement | null = this.findOrb()): HTMLElement | null {
    if (orb) {
      for (const selector of CHATGPT_SELECTORS.container) {
        const el = orb.closest<HTMLElement>(selector);
        if (el) return el;
      }
      return orb.closest<HTMLElement>('button') ?? orb;
    }
    if (this.findSessionControl() === null) return null;
    for (const selector of CHATGPT_SELECTORS.container) {
      const el = this.doc.querySelector<HTMLElement>(selector);
      if (el && isShown(el)) return el;
    }
    return null;
  }

  findOrb(): HTMLElement | null {
    for (const selector of CHATGPT_SELECTORS.orb) {
      const el = this.doc.querySelector<HTMLElement>(selector);
      // `aria-hidden` is NOT a hidden test here: production marks the orb aria-hidden="true" (it is decorative,
      // its button carries the label). Only the `hidden` attribute means it is not rendered.
      if (el && !el.hidden) return el;
    }
    return null;
  }

  private findSessionControl(): HTMLElement | null {
    for (const selector of CHATGPT_SELECTORS.sessionControl) {
      const el = this.doc.querySelector<HTMLElement>(selector);
      if (el && isShown(el)) return el;
    }
    return null;
  }

  snapshot(): VoiceUiSnapshot {
    const orb = this.findOrb();
    const container = this.findVoiceContainer(orb);
    return { active: orb !== null || container !== null, container, orb };
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

/** For containers only: a voice container marked aria-hidden is not the live one. */
function isShown(el: HTMLElement): boolean {
  return !el.hidden && el.getAttribute('aria-hidden') !== 'true';
}
