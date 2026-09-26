// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGPTAdapter } from '../../src/content/ChatGPTAdapter';

/**
 * Calibration automation on a DOM shaped like tests/e2e/fixtures/chatgpt.html. The selectors behind it are guesses
 * about chatgpt.com (see docs/calibration-wizard.md); these tests pin the adapter's logic, not the real page.
 */
function page(): { composer: HTMLTextAreaElement; send: HTMLButtonElement; sent: string[] } {
  document.body.innerHTML = '';
  const composer = document.createElement('textarea');
  composer.id = 'prompt-textarea';
  const send = document.createElement('button');
  send.dataset.testid = 'send-button';
  send.disabled = true;
  const sent: string[] = [];
  composer.addEventListener('input', () => (send.disabled = composer.value.length === 0));
  const submit = () => {
    sent.push(composer.value);
    composer.value = '';
    send.disabled = true;
  };
  composer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !send.disabled) submit();
  });
  document.body.append(composer, send);
  return { composer, send, sent };
}

function message(role: 'user' | 'assistant', text: string): HTMLElement {
  const el = document.createElement('div');
  el.dataset.messageAuthorRole = role;
  el.dataset.messageId = `m-${Math.random()}`;
  el.textContent = text;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  document.documentElement.removeAttribute('lang');
});

describe('ChatGPTAdapter automation', () => {
  it('types into a React-controlled textarea and clicks send', async () => {
    const { sent } = page();
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isComposerReady()).toBe(true);
    await expect(adapter.sendMessage('Say exactly: "Hola."')).resolves.toBe(true);
    expect(sent).toEqual(['Say exactly: "Hola."']);
  });

  it('fails without a composer and sends with Enter even when no button exists', async () => {
    const adapter = new ChatGPTAdapter(document);
    await expect(adapter.sendMessage('x')).resolves.toBe(false);
    const { send, sent } = page();
    send.remove();
    await expect(adapter.sendMessage('x', 30)).resolves.toBe(true);
    expect(sent).toEqual(['x']);
  });

  it('counts messages, waits for a new assistant reply and knows an empty chat', async () => {
    page();
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isConversationEmpty()).toBe(true);
    message('user', 'hi');
    expect(adapter.isConversationEmpty()).toBe(false);
    const before = adapter.countAssistantMessages();
    const waiting = adapter.waitForAssistantMessage(before, 1000);
    setTimeout(() => message('assistant', 'Hello there.'), 5);
    expect((await waiting)?.text).toBe('Hello there.');
    await expect(adapter.waitForAssistantMessage(adapter.countAssistantMessages(), 20)).resolves.toBeNull();
  });

  it('ensureFreshChat clicks New chat and waits for an empty conversation', async () => {
    page();
    message('assistant', 'old');
    const newChat = document.createElement('button');
    newChat.dataset.testid = 'create-new-chat-button';
    newChat.addEventListener('click', () => setTimeout(() => document.querySelectorAll('[data-message-author-role]').forEach((m) => m.remove()), 5));
    document.body.append(newChat);
    await expect(new ChatGPTAdapter(document).ensureFreshChat(1000)).resolves.toBe(true);
  });

  it('startVoice clicks the voice button and waits for the orb', async () => {
    const button = document.createElement('button');
    button.dataset.testid = 'composer-speech-button';
    button.addEventListener('click', () => {
      const orb = document.createElement('div');
      orb.dataset.realtimeVoiceOrb = 'true';
      document.body.append(orb);
    });
    document.body.append(button);
    const adapter = new ChatGPTAdapter(document);
    await expect(adapter.startVoice(1000)).resolves.toBe(true);
    expect(adapter.detectVoiceMode()).toBe('realtime');
    // The orb is sufficient; React may mount the composer and mute control after it.
    expect(adapter.isVoiceReady()).toBe(true);
  });

  it('drives the current localized Voice controls and waits until they are ready', async () => {
    const composer = document.createElement('div');
    composer.contentEditable = 'true';
    composer.setAttribute('role', 'textbox');
    const start = document.createElement('button');
    start.setAttribute('aria-label', 'Почати голосову розмову');
    start.addEventListener('click', () => {
      const orb = document.createElement('div');
      orb.dataset.realtimeVoiceOrb = 'true';
      const mute = document.createElement('button');
      mute.setAttribute('aria-label', 'Вимкнути мікрофон');
      document.body.append(orb, mute);
    });
    document.body.append(composer, start);
    const adapter = new ChatGPTAdapter(document);
    await expect(adapter.startVoice(1000)).resolves.toBe(true);
    expect(adapter.isVoiceReady()).toBe(true);
  });

  it('mutes by aria-pressed or by label and never toggles twice', async () => {
    const mute = document.createElement('button');
    mute.setAttribute('aria-label', 'Mute microphone');
    let clicks = 0;
    mute.addEventListener('click', () => {
      clicks++;
      mute.setAttribute('aria-label', mute.getAttribute('aria-label') === 'Mute microphone' ? 'Unmute microphone' : 'Mute microphone');
    });
    document.body.append(mute);
    const adapter = new ChatGPTAdapter(document);
    await adapter.setVoiceMicMuted(true);
    await adapter.setVoiceMicMuted(true);
    expect(clicks).toBe(1);
    await adapter.setVoiceMicMuted(false);
    expect(clicks).toBe(2);
    mute.remove();
    await expect(adapter.setVoiceMicMuted(true)).resolves.toBe(false);
  });

  it('understands the localized mute state and submits a Voice composer with no Send button', async () => {
    const form = document.createElement('form');
    const composer = document.createElement('div');
    composer.contentEditable = 'true';
    composer.setAttribute('role', 'textbox');
    const mute = document.createElement('button');
    mute.setAttribute('aria-label', 'Вимкнути мікрофон');
    mute.addEventListener('click', () => mute.setAttribute('aria-label', mute.getAttribute('aria-label') === 'Вимкнути мікрофон' ? 'Увімкнути мікрофон' : 'Вимкнути мікрофон'));
    let submitted = '';
    composer.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      submitted = composer.textContent ?? '';
      composer.textContent = '';
    });
    form.append(composer);
    document.body.append(form, mute);
    const adapter = new ChatGPTAdapter(document);
    await expect(adapter.setVoiceMicMuted(true)).resolves.toBe(true);
    await expect(adapter.setVoiceMicMuted(true)).resolves.toBe(true);
    await expect(adapter.sendMessage('Тестовая фраза')).resolves.toBe(true);
    expect(submitted).toBe('Тестовая фраза');
  });

  it('detects the voice from a checked option (known names only), a label, or stored settings', () => {
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.detectVoiceEnvironment()).toEqual({ voiceName: null, voiceMode: null, uiLanguage: null, detectedFrom: 'unknown' });

    const model = document.createElement('div');
    model.setAttribute('role', 'menuitemradio');
    model.setAttribute('aria-checked', 'true');
    model.textContent = 'GPT-5';
    document.body.append(model);
    expect(adapter.detectSelectedVoice()).toBeNull();

    localStorage.setItem('oai/voice-name', 'juniper');
    expect(adapter.detectSelectedVoice()).toEqual({ name: 'Juniper', from: 'settings' });

    const label = document.createElement('button');
    label.setAttribute('aria-label', 'Voice: Nova Prime');
    document.body.append(label);
    expect(adapter.detectSelectedVoice()).toEqual({ name: 'Nova Prime', from: 'aria' });

    const option = document.createElement('div');
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', 'true');
    option.textContent = 'Sol';
    document.body.append(option);
    document.documentElement.setAttribute('lang', 'ru-RU');
    expect(adapter.detectVoiceEnvironment()).toEqual({ voiceName: 'Sol', voiceMode: null, uiLanguage: 'ru-RU', detectedFrom: 'aria' });
  });

  it('counts text-chat and Voice Mode assistant turns together, so a voice reply after text ones is seen', async () => {
    page();
    const adapter = new ChatGPTAdapter(document);
    message('assistant', 'Text reply.');
    const before = adapter.countAssistantMessages();
    const waiting = adapter.waitForAssistantMessage(before, 1000);
    setTimeout(() => {
      const turn = document.createElement('div');
      turn.dataset.contentSearchUnitKey = 'fallback-turn-2:1:assistant';
      const sel = document.createElement('div');
      sel.dataset.chatgptSelectionMessageId = 'v1';
      const body = document.createElement('div');
      body.dataset.markdownTextStyle = 'assistant-message';
      body.textContent = 'Voice reply.';
      sel.append(body);
      turn.append(sel);
      document.body.append(turn);
    }, 5);
    expect((await waiting)?.text).toBe('Voice reply.');
    expect(adapter.countAssistantMessages()).toBe(2);
  });
});
