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

/** Read-only adapter diagnostics for live selector-drift investigations. No DOM node escapes the adapter. */
export interface ChatGPTAdapterDebugSnapshot {
  conversationRootFound: boolean;
  /** Selector that found the root, when one did. */
  conversationRootSelector: string | null;
  activeAssistantTurn: string | null;
  revision: number;
  assistantMessageSelector: string | null;
  messageBodySelector: string | null;
  assistantText: string;
  observerConnected: boolean;
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
   * Production Voice Mode wraps its complete transcript in the first data selector; the logged-out shell exposes
   * the ARIA-region fallback. Both are roots, not turn selectors: the assistant turn is identified below.
   */
  conversationRoot: ['[data-chatgpt-conversation-selection-target="true"]', '[role="region"][aria-label="Conversation"]'],
  /**
   * One assistant turn. Text chat uses the long-standing role attribute. Production Voice Mode (2026-09-26) uses
   * `data-content-search-unit-key="fallback-turn-N:1:assistant"` instead; its child h4 has
   * `data-conversation-role="assistant"`. The turn key is a stable data contract, unlike the surrounding CSS.
   */
  assistantMessage: ['[data-message-author-role="assistant"]', '[data-content-search-unit-key$=":assistant"]'],
  /** Rendered assistant text in text chat and the separate Voice Mode transcript, respectively. */
  messageBody: ['.markdown', '[class*="markdown"]', '[data-markdown-text-style="assistant-message"]'],
  /** Voice Mode keeps its immutable message UUID on this descendant, not on the turn wrapper. */
  messageId: ['[data-chatgpt-selection-message-id]'],
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
  private revision = 0;
  private lastReplyKey: string | null = null;
  private lastAssistantMessageSelector: string | null = null;
  private lastMessageBodySelector: string | null = null;
  private repliesObserverConnected = false;

  constructor(private readonly doc: Document = document) {}

  readLatestReply(): AssistantReply | null {
    const { message, selector: assistantMessageSelector } = this.findLatestAssistantMessage();
    if (!message) return null;
    let body: Element = message;
    let messageBodySelector: string | null = null;
    for (const selector of CHATGPT_SELECTORS.messageBody) {
      const el = message.querySelector(selector);
      if (el) {
        body = el;
        messageBodySelector = selector;
        break;
      }
    }
    let id = message.getAttribute('data-message-id');
    if (!id) {
      for (const selector of CHATGPT_SELECTORS.messageId) {
        id = message.querySelector(selector)?.getAttribute('data-chatgpt-selection-message-id') ?? null;
        if (id) break;
      }
    }
    if (!id) {
      id = this.ids.get(message) ?? `prosopon-${++this.nextId}`;
      this.ids.set(message, id);
    }
    const text = replyText(body);
    const key = `${id}\u0000${text}`;
    if (key !== this.lastReplyKey) {
      this.lastReplyKey = key;
      this.revision++;
    }
    this.lastAssistantMessageSelector = assistantMessageSelector;
    this.lastMessageBodySelector = messageBodySelector;
    return { id, text };
  }

  observeReplies(onChange: () => void): () => void {
    // Observe only the conversation subtree while it exists. A lightweight document observer only rebinds after
    // ChatGPT's SPA replaces that subtree; it never marks semantic input dirty for unrelated page churn.
    let observedRoot: Element | null = null;
    let repliesObserver: MutationObserver | null = null;
    const bind = () => {
      const nextRoot = this.findConversationRoot().element ?? this.doc.body ?? this.doc.documentElement;
      if (nextRoot === observedRoot) return;
      repliesObserver?.disconnect();
      observedRoot = nextRoot;
      repliesObserver = new MutationObserver(() => onChange());
      repliesObserver.observe(nextRoot, { childList: true, subtree: true, characterData: true });
      onChange();
    };
    const lifecycle = new MutationObserver(bind);
    lifecycle.observe(this.doc.documentElement, { childList: true, subtree: true });
    this.repliesObserverConnected = true;
    bind();
    return () => {
      lifecycle.disconnect();
      repliesObserver?.disconnect();
      this.repliesObserverConnected = false;
    };
  }

  /** Safe to expose in a dev build: selector choices and serialised text, never elements. */
  debugSnapshot(): ChatGPTAdapterDebugSnapshot {
    const root = this.findConversationRoot();
    const reply = this.readLatestReply();
    return {
      conversationRootFound: root.element !== null,
      conversationRootSelector: root.selector,
      activeAssistantTurn: reply?.id ?? null,
      revision: this.revision,
      assistantMessageSelector: this.lastAssistantMessageSelector,
      messageBodySelector: this.lastMessageBodySelector,
      assistantText: reply?.text ?? '',
      observerConnected: this.repliesObserverConnected,
    };
  }

  private findConversationRoot(): { element: Element | null; selector: string | null } {
    for (const selector of CHATGPT_SELECTORS.conversationRoot) {
      const element = this.doc.querySelector(selector);
      if (element) return { element, selector };
    }
    return { element: null, selector: null };
  }

  private findLatestAssistantMessage(): { message: Element | null; selector: string | null } {
    // The canonical thread wins over page-wide mirrors (for example accessibility or voice-overlay copies).
    const root = this.findConversationRoot().element;
    for (const scope of root ? [root, this.doc] : [this.doc]) {
      let latest: { message: Element; selector: string } | null = null;
      for (const selector of CHATGPT_SELECTORS.assistantMessage) {
        const all = scope.querySelectorAll(selector);
        for (const message of all) {
          if (!latest || (latest.message.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
            latest = { message, selector };
          }
        }
      }
      if (latest) return latest;
    }
    return { message: null, selector: null };
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
