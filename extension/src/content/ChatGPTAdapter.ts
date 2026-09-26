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

/** What could be learned about ChatGPT's voice configuration from the page. Nothing here is guessed from elsewhere. */
export interface ChatGPTVoiceEnvironment {
  /** The selected voice as ChatGPT names it ("Sol"), normalized to a known spelling when it matches one. */
  voiceName: string | null;
  /**
   * The kind of voice session the page shows, as far as the DOM tells: 'realtime' while the realtime voice orb is
   * mounted, null otherwise. Never a backend model name.
   */
  voiceMode: string | null;
  /** `<html lang>` of the page. */
  uiLanguage: string | null;
  /** Where voiceName came from. */
  detectedFrom: 'dom' | 'aria' | 'settings' | 'unknown';
}

/**
 * Driving ChatGPT for the calibration wizard: a new chat, the composer, the voice session. Typed and DOM-free for
 * the caller; every method is best effort and reports failure instead of throwing, so the wizard can fall back to
 * asking the user. Nothing here runs unless the calibration wizard (Developer Mode) calls it.
 */
export interface ConversationAutomation {
  /** Voice names ChatGPT is known to offer (normalization and the manual fallback list only; may be outdated). */
  readonly knownVoices: readonly string[];
  detectSelectedVoice(): { name: string; from: ChatGPTVoiceEnvironment['detectedFrom'] } | null;
  detectVoiceMode(): string | null;
  detectVoiceEnvironment(): ChatGPTVoiceEnvironment;
  /** No user or assistant message in the current conversation. */
  isConversationEmpty(): boolean;
  /** The message composer exists and is editable. */
  isComposerReady(): boolean;
  /** Assistant messages in the thread (to wait for the next one). */
  countAssistantMessages(): number;
  /** An empty conversation with a ready composer: the current one if it already is, else a new chat. */
  ensureFreshChat(timeoutMs?: number): Promise<boolean>;
  /** Starts ChatGPT Voice (no-op when it runs). Resolves once the voice UI is up, false on timeout. */
  startVoice(timeoutMs?: number): Promise<boolean>;
  /** Mutes/unmutes ChatGPT's own microphone in the voice session. False when no such control was found. */
  setVoiceMicMuted(muted: boolean): Promise<boolean>;
  /** Types `text` into the composer and sends it. False when the composer or the send control was not found. */
  sendMessage(text: string, timeoutMs?: number): Promise<boolean>;
  /** Resolves with the first assistant message after the first `afterCount` ones, or null on timeout. */
  waitForAssistantMessage(afterCount: number, timeoutMs?: number): Promise<AssistantReply | null>;
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

  // --- Calibration wizard only (Developer Mode). NONE of these was verified against production chatgpt.com: they
  // --- are the long-standing attributes as publicly described. Manual check: docs/calibration-wizard.md.

  /** Any turn of the conversation (empty-chat check); the Voice Mode turn key per assistantMessage above. */
  anyMessage: ['[data-message-author-role]', '[data-content-search-unit-key$=":assistant"]', '[data-content-search-unit-key$=":user"]'],
  /** The composer: ProseMirror contenteditable (#prompt-textarea) or a plain textarea on older builds. */
  composer: ['#prompt-textarea', '[contenteditable="true"][role="textbox"]', 'textarea[name="prompt-textarea"]', 'form textarea'],
  sendButton: ['[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label="Send prompt" i]', 'button[aria-label*="send" i]'],
  newChat: ['[data-testid="create-new-chat-button"]', 'a[aria-label="New chat" i]', 'button[aria-label="New chat" i]'],
  /** Starts a voice session from the composer. */
  voiceButton: [
    '[data-testid="composer-speech-button"]',
    'button[aria-label="Start voice mode" i]',
    'button[aria-label*="voice mode" i]:not([aria-label*="focus" i])',
    'button[aria-label="Voice" i]',
  ],
  /** ChatGPT's own mic mute in a voice session (aria-pressed or the label tells the state). */
  voiceMute: ['button[aria-label="Mute microphone" i]', 'button[aria-label="Unmute microphone" i]', 'button[aria-label*="mute" i]'],
  /** A checked option in a voice picker (menu, radio group, listbox) that may be on the page. */
  selectedOption: ['[role="menuitemradio"][aria-checked="true"]', '[role="radio"][aria-checked="true"]', '[role="option"][aria-selected="true"]'],
  /** Elements whose label may name the voice ("Voice: Sol"). */
  labelled: ['[aria-label*="voice" i]', '[title*="voice" i]'],
} as const;

/** Voice names ChatGPT offered as of 2026 (normalization only; an unknown name is still reported as is). */
export const KNOWN_CHATGPT_VOICES = ['Arbor', 'Breeze', 'Cove', 'Ember', 'Juniper', 'Maple', 'Sol', 'Spruce', 'Vale', 'Monday'] as const;

/** Page localStorage keys that may hold the voice setting (read-only; unverified, see CHATGPT_SELECTORS). */
const VOICE_STORAGE_KEY = /voice/i;

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

export class ChatGPTAdapter implements ConversationUiAdapter, ConversationAutomation {
  readonly knownVoices: readonly string[] = KNOWN_CHATGPT_VOICES;

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

  // --- Automation (calibration wizard) --------------------------------------------------------------------------

  detectSelectedVoice(): { name: string; from: ChatGPTVoiceEnvironment['detectedFrom'] } | null {
    // 1. A checked option of a voice picker. Only a known voice name counts: the model picker uses the same roles.
    for (const el of this.all(CHATGPT_SELECTORS.selectedOption)) {
      const name = knownVoice(el.getAttribute('aria-label') ?? el.textContent ?? '');
      if (name) return { name, from: 'aria' };
    }
    // 2. A label that names it ("Voice: Sol", "Sol voice").
    for (const el of this.all(CHATGPT_SELECTORS.labelled)) {
      const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
      const name = knownVoice(label) ?? /\bvoice\s*[:\-–]\s*([\p{L}][\p{L}\p{N} ]{1,23})/iu.exec(label)?.[1]?.trim() ?? null;
      if (name) return { name: knownVoice(name) ?? name, from: 'aria' };
    }
    // 3. The page's own stored setting.
    try {
      const storage = this.doc.defaultView?.localStorage;
      if (storage) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !VOICE_STORAGE_KEY.test(key)) continue;
          const name = knownVoice(storage.getItem(key) ?? '');
          if (name) return { name, from: 'settings' };
        }
      }
    } catch {
      // Storage access can throw (sandboxed frames); detection just fails.
    }
    return null;
  }

  detectVoiceMode(): string | null {
    // Grounded in a verified attribute only: the realtime voice orb (see CHATGPT_SELECTORS.orb).
    return this.doc.querySelector('[data-realtime-voice-orb]') ? 'realtime' : null;
  }

  detectVoiceEnvironment(): ChatGPTVoiceEnvironment {
    const voice = this.detectSelectedVoice();
    return {
      voiceName: voice?.name ?? null,
      voiceMode: this.detectVoiceMode(),
      uiLanguage: this.doc.documentElement.getAttribute('lang') || null,
      detectedFrom: voice?.from ?? 'unknown',
    };
  }

  isConversationEmpty(): boolean {
    return this.first(CHATGPT_SELECTORS.anyMessage) === null;
  }

  isComposerReady(): boolean {
    const el = this.first(CHATGPT_SELECTORS.composer);
    return el !== null && isEditable(el);
  }

  countAssistantMessages(): number {
    // Every shape at once (text-chat turns and Voice Mode turns can share a thread), each element once.
    return this.doc.querySelectorAll(CHATGPT_SELECTORS.assistantMessage.join(', ')).length;
  }

  async ensureFreshChat(timeoutMs = 8000): Promise<boolean> {
    if (this.isConversationEmpty() && this.isComposerReady()) return true;
    const button = this.first(CHATGPT_SELECTORS.newChat);
    if (!button) return false;
    button.click();
    return this.waitFor(() => this.isConversationEmpty() && this.isComposerReady(), timeoutMs);
  }

  async startVoice(timeoutMs = 10000): Promise<boolean> {
    if (this.isVoiceModeActive()) return true;
    const button = this.first(CHATGPT_SELECTORS.voiceButton);
    if (!button) return false;
    button.click();
    return this.waitFor(() => this.isVoiceModeActive(), timeoutMs);
  }

  async setVoiceMicMuted(muted: boolean): Promise<boolean> {
    const button = this.first(CHATGPT_SELECTORS.voiceMute);
    if (!button) return false;
    const pressed = button.getAttribute('aria-pressed');
    const label = button.getAttribute('aria-label') ?? '';
    // "Unmute microphone" is shown while muted; aria-pressed, when present, is the mute state.
    const isMuted = pressed !== null ? pressed === 'true' : /unmute/i.test(label);
    if (isMuted !== muted) button.click();
    return true;
  }

  async sendMessage(text: string, timeoutMs = 5000): Promise<boolean> {
    const composer = this.first(CHATGPT_SELECTORS.composer);
    if (!composer || !isEditable(composer)) return false;
    composer.focus();
    if (composer instanceof this.win().HTMLTextAreaElement) {
      // React tracks the value through the native setter; a plain assignment is invisible to it.
      const setter = Object.getOwnPropertyDescriptor(this.win().HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(composer, text);
      composer.dispatchEvent(new (this.win().Event)('input', { bubbles: true }));
    } else {
      // ProseMirror: replace the selection through the editing command, which it handles like typing.
      const selection = this.doc.getSelection();
      selection?.selectAllChildren(composer);
      const inserted = typeof this.doc.execCommand === 'function' && this.doc.execCommand('insertText', false, text);
      if (!inserted) {
        composer.textContent = text;
        composer.dispatchEvent(new (this.win().InputEvent)('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
    const ready = await this.waitFor(() => {
      const b = this.first(CHATGPT_SELECTORS.sendButton);
      return b !== null && !(b as HTMLButtonElement).disabled;
    }, timeoutMs);
    if (!ready) return false;
    this.first(CHATGPT_SELECTORS.sendButton)!.click();
    return true;
  }

  async waitForAssistantMessage(afterCount: number, timeoutMs = 20000): Promise<AssistantReply | null> {
    const ok = await this.waitFor(() => this.countAssistantMessages() > afterCount, timeoutMs);
    return ok ? this.readLatestReply() : null;
  }

  private first(selectors: readonly string[]): HTMLElement | null {
    for (const selector of selectors) {
      const el = this.doc.querySelector<HTMLElement>(selector);
      if (el) return el;
    }
    return null;
  }

  private all(selectors: readonly string[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const selector of selectors) out.push(...this.doc.querySelectorAll<HTMLElement>(selector));
    return out;
  }

  private win(): Window & typeof globalThis {
    return (this.doc.defaultView ?? window) as Window & typeof globalThis;
  }

  /** Resolves true once `test` holds (checked on DOM mutations), false after `timeoutMs`. */
  private waitFor(test: () => boolean, timeoutMs: number): Promise<boolean> {
    if (test()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        if (test()) done(true);
      });
      observer.observe(this.doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const timer = setTimeout(() => done(test()), timeoutMs);
    });
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

/** The known voice named in `text` ("Sol", "Voice: sol"), else null. */
function knownVoice(text: string): string | null {
  const words = text.toLowerCase().split(/[^\p{L}]+/u);
  return KNOWN_CHATGPT_VOICES.find((v) => words.includes(v.toLowerCase())) ?? null;
}

function isEditable(el: HTMLElement): boolean {
  if ('disabled' in el && (el as HTMLTextAreaElement).disabled) return false;
  return el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('contenteditable') === 'true';
}

/** For containers only: a voice container marked aria-hidden is not the live one. */
function isShown(el: HTMLElement): boolean {
  return !el.hidden && el.getAttribute('aria-hidden') !== 'true';
}
