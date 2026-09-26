// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAdapter, type VoiceUiSnapshot } from '../../src/content/ChatGPTAdapter';

/**
 * Production chatgpt.com voice UI (2026-09-26), as in tests/e2e/fixtures/chatgpt.html: the orb is decorative and
 * carries aria-hidden="true"; its label lives on the button; the focus-mode div is the container.
 */
function voiceUi(): HTMLElement {
  const container = document.createElement('div');
  container.dataset.threadFocusMode = 'true';
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Exit voice focus mode');
  const orb = document.createElement('div');
  orb.dataset.realtimeVoiceOrb = 'true';
  orb.dataset.testid = 'avatar-overlay-voice-orb';
  orb.setAttribute('aria-hidden', 'true');
  button.append(orb);
  container.append(button);
  return container;
}

const orbOf = (ui: HTMLElement): HTMLElement => ui.querySelector<HTMLElement>('[data-realtime-voice-orb]')!;

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '<main id="app"><p>chat</p></main>';
});

describe('ChatGPTAdapter', () => {
  it('detects the voice UI and its orb', () => {
    document.body.append(voiceUi());
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(true);
    expect(adapter.findVoiceContainer()?.dataset.threadFocusMode).toBe('true');
    expect(adapter.findOrb()?.dataset.testid).toBe('avatar-overlay-voice-orb');
  });

  it('reports absence without throwing', () => {
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(false);
    expect(adapter.findVoiceContainer()).toBeNull();
    expect(adapter.findOrb()).toBeNull();
  });

  // Regression (US-005): production marks the orb aria-hidden="true"; reading that as "not rendered" left the
  // avatar permanently in its fallback position on the real site.
  it('detects the orb even though production marks it aria-hidden', () => {
    document.body.append(voiceUi());
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.findOrb()?.getAttribute('aria-hidden')).toBe('true');
    expect(adapter.isVoiceModeActive()).toBe(true);
  });

  it('treats an orb marked with the hidden attribute as absent', () => {
    const ui = voiceUi();
    orbOf(ui).hidden = true;
    document.body.append(ui);
    expect(new ChatGPTAdapter(document).findOrb()).toBeNull();
  });

  // Regression (US-005): production has no voice dialog, and in the composer no known container ancestor either.
  it('falls back to the orb button as container when no known container wraps the orb', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Enter voice focus mode');
    const orb = document.createElement('div');
    orb.dataset.realtimeVoiceOrb = 'true';
    button.append(orb);
    document.body.append(button);
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(true);
    expect(adapter.findVoiceContainer()).toBe(button);
  });

  it('stays active while only the End Voice control is present', () => {
    const end = document.createElement('button');
    end.setAttribute('aria-label', 'End Voice');
    document.body.append(end);
    expect(new ChatGPTAdapter(document).isVoiceModeActive()).toBe(true);
  });

  it('notifies when the voice UI appears later and when it disappears', async () => {
    const adapter = new ChatGPTAdapter(document);
    const seen: VoiceUiSnapshot[] = [];
    const stop = adapter.observe((ui) => seen.push(ui));
    expect(seen.map((s) => s.active)).toEqual([false]);

    const ui = voiceUi();
    document.getElementById('app')!.append(ui);
    await flush();
    expect(seen.map((s) => s.active)).toEqual([false, true]);
    expect(seen[1]!.orb).toBe(orbOf(ui));

    ui.remove();
    await flush();
    expect(seen.map((s) => s.active)).toEqual([false, true, false]);
    stop();
  });

  it('ignores unrelated mutations and stops observing on unsubscribe', async () => {
    const adapter = new ChatGPTAdapter(document);
    const listener = vi.fn();
    const stop = adapter.observe(listener);
    for (let i = 0; i < 20; i++) document.getElementById('app')!.append(document.createElement('span'));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    document.body.append(voiceUi());
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hides the orb visually without removing it, and restores its inline style', () => {
    const ui = voiceUi();
    document.body.append(ui);
    const orb = orbOf(ui);
    orb.style.setProperty('visibility', 'visible');
    const adapter = new ChatGPTAdapter(document);

    const restore = adapter.hideVisually(orb);
    expect(orb.isConnected).toBe(true);
    expect(orb.style.getPropertyValue('visibility')).toBe('hidden');
    expect(adapter.hideVisually(orb)).toBeTypeOf('function'); // second hide is a no-op

    restore();
    restore();
    expect(orb.style.getPropertyValue('visibility')).toBe('visible');
    expect(orb.hasAttribute('data-prosopon-hidden')).toBe(false);
  });
});

describe('ChatGPTAdapter: assistant reply text (semantic layer input)', () => {
  const conversation = (): HTMLElement => {
    const root = document.createElement('div');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Conversation');
    document.body.append(root);
    return root;
  };
  const reply = (html: string, id?: string): HTMLElement => {
    const m = document.createElement('div');
    m.dataset.messageAuthorRole = 'assistant';
    if (id) m.dataset.messageId = id;
    m.innerHTML = `<div class="markdown prose">${html}</div><button>Copy</button>`;
    document.body.append(m);
    return m;
  };

  it('no reply → null', () => {
    expect(new ChatGPTAdapter(document).readLatestReply()).toBeNull();
  });

  it('reads the latest assistant message, not the user’s, as light Markdown', () => {
    const user = document.createElement('div');
    user.dataset.messageAuthorRole = 'user';
    user.textContent = 'Но почему?';
    document.body.append(user);
    reply('<p>Old.</p>', 'a1');
    reply(
      '<h3>Итог</h3><p>Есть <strong>три</strong> варианта:</p><ol><li><p>Первый</p></li><li>Второй</li></ol>' +
        '<ul><li>пункт</li></ul><pre><code>if (a) { but(); }</code></pre><p>Используй <code>npm i</code>, <em>но</em> осторожно.</p>',
      'a2',
    );
    const r = new ChatGPTAdapter(document).readLatestReply()!;
    expect(r.id).toBe('a2');
    expect(r.text).toBe('### Итог\n\nЕсть **три** варианта:\n\n1. Первый\n2. Второй\n- пункт\n\n```\n```\n\nИспользуй `npm i`, *но* осторожно.');
    expect(r.text).not.toMatch(/Copy|but\(\)/);
  });

  it('ordered lists honour start; hidden and aria-hidden nodes are skipped', () => {
    reply('<ol start="3"><li>c</li><li>d</li></ol><span aria-hidden="true">x</span><p hidden>y</p>');
    expect(new ChatGPTAdapter(document).readLatestReply()!.text).toBe('3. c\n4. d');
  });

  it('a message without data-message-id keeps one stable id across reads', () => {
    const m = reply('<p>Да.</p>');
    const adapter = new ChatGPTAdapter(document);
    const a = adapter.readLatestReply()!;
    m.querySelector('p')!.textContent = 'Да, но есть нюанс.';
    const b = adapter.readLatestReply()!;
    expect(b.id).toBe(a.id);
    expect(b.text).toBe('Да, но есть нюанс.');
    reply('<p>Next.</p>');
    expect(adapter.readLatestReply()!.id).not.toBe(a.id);
  });

  // Production Voice Mode (observed 2026-09-26): it does not use data-message-author-role or .markdown.
  // The sr-only heading is role evidence; the turn wrapper and markdown-style body carry durable data attributes.
  const voiceReply = (text: string, id: string): HTMLElement => {
    const turn = document.createElement('div');
    turn.dataset.contentSearchUnitKey = `fallback-turn-4:1:assistant`;
    turn.innerHTML = `<h4 data-conversation-role="assistant">ChatGPT said:</h4>
      <div data-chatgpt-selection-message-id="${id}">
        <div data-markdown-text-style="assistant-message"><p>${text}</p></div>
      </div>`;
    document.body.append(turn);
    return turn;
  };

  it('reads a live Voice Mode assistant turn and its stable nested message id', () => {
    const turn = voiceReply('Но тут есть важный нюанс.', 'voice-message-7');
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.readLatestReply()).toEqual({ id: 'voice-message-7', text: 'Но тут есть важный нюанс.' });

    turn.querySelector('p')!.textContent = 'Но тут есть важный нюанс. Есть три варианта.';
    expect(adapter.readLatestReply()).toEqual({ id: 'voice-message-7', text: 'Но тут есть важный нюанс. Есть три варианта.' });
    expect(adapter.debugSnapshot()).toMatchObject({
      assistantMessageSelector: '[data-content-search-unit-key$=":assistant"]',
      messageBodySelector: '[data-markdown-text-style="assistant-message"]',
      revision: 2,
    });
  });

  it('chooses the newest turn across text-chat and Voice Mode selector families', () => {
    reply('<p>Older text-chat reply.</p>', 'text-old');
    voiceReply('Newer Voice reply.', 'voice-new');
    expect(new ChatGPTAdapter(document).readLatestReply()).toEqual({ id: 'voice-new', text: 'Newer Voice reply.' });
  });

  it('ignores a Voice Mode user transcript even when it is newer than the assistant turn', () => {
    voiceReply('Assistant reply.', 'voice-assistant');
    const user = document.createElement('div');
    user.dataset.contentSearchUnitKey = 'fallback-turn-5:0:user';
    user.textContent = 'Newest user transcript.';
    document.body.append(user);
    expect(new ChatGPTAdapter(document).readLatestReply()).toEqual({ id: 'voice-assistant', text: 'Assistant reply.' });
  });

  it('observeReplies fires on streaming text changes and stops on dispose', async () => {
    const m = reply('<p>Н</p>');
    const adapter = new ChatGPTAdapter(document);
    const onChange = vi.fn();
    const stop = adapter.observeReplies(onChange);
    m.querySelector('p')!.firstChild!.textContent = 'Но';
    await flush();
    expect(onChange).toHaveBeenCalled();
    stop();
    onChange.mockClear();
    m.querySelector('p')!.append(' есть нюанс.');
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('prefers the canonical production conversation region over an out-of-thread mirror', () => {
    const root = conversation();
    const canonical = document.createElement('div');
    canonical.dataset.messageAuthorRole = 'assistant';
    canonical.dataset.messageId = 'canonical';
    canonical.innerHTML = '<div class="markdown"><p>Current reply.</p></div>';
    root.append(canonical);
    const mirror = reply('<p>Stale accessibility mirror.</p>', 'mirror');

    const adapter = new ChatGPTAdapter(document);
    expect(adapter.readLatestReply()).toMatchObject({ id: 'canonical', text: 'Current reply.' });
    expect(adapter.debugSnapshot()).toMatchObject({
      conversationRootFound: true,
      conversationRootSelector: '[role="region"][aria-label="Conversation"]',
      activeAssistantTurn: 'canonical',
      revision: 1,
      assistantMessageSelector: '[data-message-author-role="assistant"]',
      messageBodySelector: '.markdown',
    });
    mirror.remove();
  });

  it('keeps semantic observation scoped to the conversation and rebinds after SPA replacement', async () => {
    const first = conversation();
    const adapter = new ChatGPTAdapter(document);
    const onChange = vi.fn();
    const stop = adapter.observeReplies(onChange);
    onChange.mockClear(); // initial bind is intentionally dirty

    document.getElementById('app')!.append(document.createElement('aside'));
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    first.append(document.createElement('p'));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    onChange.mockClear();

    const replacement = document.createElement('div');
    replacement.setAttribute('role', 'region');
    replacement.setAttribute('aria-label', 'Conversation');
    first.replaceWith(replacement);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(adapter.debugSnapshot().observerConnected).toBe(true);
    stop();
    expect(adapter.debugSnapshot().observerConnected).toBe(false);
  });
});
