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
  /**
   * The assistant's latest reply as it is displayed (streaming included), serialized to light Markdown, or null.
   * Text only: no DOM node leaves the adapter.
   */
  readLatestReply(): AssistantReply | null;
  /** Calls `onChange` (no arguments, cheap) whenever the conversation's text may have changed. @returns stop */
  observeReplies(onChange: () => void): () => void;
}

export interface AssistantReply {
  /** Stable per reply (ChatGPT's message id when present). */
  id: string;
  /** Paragraphs separated by blank lines; list items as "1. " / "- "; **bold**, *italic*, # headings; code blocks
   * reduced to an empty fence (code is not speech). */
  text: string;
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
  /**
   * One assistant turn in the thread (text chat and, when ChatGPT shows it, the voice reply's text). NOT verified
   * against production voice mode: `data-message-author-role` is the long-standing thread attribute; whether the
   * voice reply's text is in the DOM while it is spoken is a manual check (docs/semantic-calibration.md).
   */
  assistantMessage: ['[data-message-author-role="assistant"]'],
  /** The rendered Markdown inside an assistant message (the message element itself when absent). */
  messageBody: ['.markdown', '[class*="markdown"]'],
} as const;

/** Attributes whose changes can show or hide the voice UI. `class` is left out: ChatGPT rewrites it constantly. */
const OBSERVED_ATTRIBUTES = ['data-testid', 'data-realtime-voice-orb', 'data-thread-focus-mode', 'hidden', 'aria-hidden', 'aria-label', 'role'];

const HIDDEN_MARK = 'data-prosopon-hidden';

/** Elements whose content is not part of what the assistant says. */
const SKIP_TAGS = new Set(['BUTTON', 'svg', 'SVG', 'STYLE', 'SCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'NOSCRIPT', 'TEMPLATE', 'CANVAS', 'IMG', 'VIDEO', 'AUDIO', 'TABLE', 'MATH', 'math', 'FORM']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'HR', 'DETAILS', 'FIGURE']);

/** Rendered message DOM → light Markdown (see AssistantReply.text). Generic HTML semantics, no ChatGPT classes. */
export function replyText(root: Element): string {
  let out = '';
  const breakLine = (count: 1 | 2) => {
    out = out.replace(/[ \t]+$/, '');
    if (!out) return;
    const have = /\n*$/.exec(out)![0].length;
    if (have < count) out += '\n'.repeat(count - have);
  };
  /** Nesting depth of <li>. */
  let item = 0;
  /** Emphasis markers around the children; none for an empty element (no stray "**"). */
  const wrap = (marker: string, children: () => void) => {
    const start = out.length;
    out += marker;
    children();
    if (out.slice(start + marker.length).trim()) out += marker;
    else out = out.slice(0, start);
  };
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out += (node as Text).data;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag) || el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return;
    const children = () => el.childNodes.forEach(walk);
    switch (tag) {
      case 'PRE':
        breakLine(2);
        out += '```\n```';
        breakLine(2);
        return;
      case 'CODE':
        out += `\`${el.textContent ?? ''}\``;
        return;
      case 'BR':
        out += '\n';
        return;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        breakLine(2);
        out += `${'#'.repeat(Number(tag[1]))} `;
        children();
        breakLine(2);
        return;
      case 'UL': case 'OL':
        breakLine(1);
        children();
        breakLine(1);
        return;
      case 'LI': {
        breakLine(1);
        const list = el.parentElement;
        if (list?.tagName === 'OL') {
          const start = Number(list.getAttribute('start') ?? 1) || 1;
          let index = 0;
          for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === 'LI') index++;
          out += `${start + index}. `;
        } else out += '- ';
        item++;
        children();
        item--;
        breakLine(1);
        return;
      }
      case 'STRONG': case 'B':
        wrap('**', children);
        return;
      case 'EM': case 'I':
        wrap('*', children);
        return;
      default:
        if (BLOCK_TAGS.has(tag)) {
          // Inside a list item (<li><p>…</p></li>) a paragraph neither splits the item from its marker nor the list.
          if (!item) breakLine(2);
          children();
          breakLine(item ? 1 : 2);
        } else children();
    }
  };
  walk(root);
  return out.trim();
}

export class ChatGPTAdapter implements ConversationUiAdapter {
  /** Ids for messages without `data-message-id` (kept per element, so a re-read gets the same id). */
  private readonly ids = new WeakMap<Element, string>();
  private nextId = 0;

  constructor(private readonly doc: Document = document) {}

  readLatestReply(): AssistantReply | null {
    let message: Element | null = null;
    for (const selector of CHATGPT_SELECTORS.assistantMessage) {
      const all = this.doc.querySelectorAll(selector);
      if (all.length) {
        message = all[all.length - 1]!;
        break;
      }
    }
    if (!message) return null;
    let body: Element = message;
    for (const selector of CHATGPT_SELECTORS.messageBody) {
      const el = message.querySelector(selector);
      if (el) {
        body = el;
        break;
      }
    }
    let id = message.getAttribute('data-message-id');
    if (!id) {
      id = this.ids.get(message) ?? `prosopon-${++this.nextId}`;
      this.ids.set(message, id);
    }
    return { id, text: replyText(body) };
  }

  observeReplies(onChange: () => void): () => void {
    // The body, not a thread container: SPA navigation replaces those. Prosopon's own UI lives in shadow roots and
    // is not seen. Only a flag is set per batch; reading and analysing happen at a bounded rate in the render loop.
    const target = this.doc.body ?? this.doc.documentElement;
    const observer = new MutationObserver(() => onChange());
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }

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
